package ui.salyra.upload;

import static ui.salyra.upload.UploadEngine.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.io.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;

public final class Filesystem {
  static String safe(String id) throws IOException {
    if (!id.matches("[a-zA-Z0-9_-]{1,100}")) throw fail(400, "ID", "Invalid upload identifier");
    return id;
  }

  static void atomic(Path path, JsonNode value) throws Exception {
    Files.createDirectories(path.getParent());
    Path temp = Files.createTempFile(path.getParent(), ".json-", ".tmp");
    try {
      Files.write(temp, JSON.writeValueAsBytes(value));
      try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
        channel.force(true);
      }
      Files.move(temp, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    } finally {
      Files.deleteIfExists(temp);
    }
  }

  public static final class Sessions implements SessionStore {
    final Path directory;

    public Sessions(Path directory) {
      this.directory = directory;
    }

    public AutoCloseable lock(String id, Context context) throws Exception {
      Files.createDirectories(directory);
      FileChannel channel =
          FileChannel.open(
              directory.resolve(safe(id) + ".lock"),
              StandardOpenOption.CREATE,
              StandardOpenOption.WRITE);
      try {
        while (true) {
          context.check();
          try {
            FileLock lock = channel.tryLock();
            if (lock != null)
              return () -> {
                lock.release();
                channel.close();
              };
          } catch (OverlappingFileLockException busy) {
          }
          Thread.sleep(10);
        }
      } catch (Exception error) {
        channel.close();
        throw error;
      }
    }

    public ObjectNode get(String id) throws Exception {
      Path path = directory.resolve(safe(id) + ".json");
      return Files.exists(path) ? (ObjectNode) JSON.readTree(Files.readAllBytes(path)) : null;
    }

    public void save(ObjectNode session) throws Exception {
      String id = safe(session.path("id").asText());
      atomic(directory.resolve(id + ".json"), session);
      String state = session.path("state").asText();
      JsonNode descriptor = session.path("descriptor");
      long chunk = descriptor.path("chunkSize").asLong();
      if ((state.equals("completed") || state.equals("canceled") || state.equals("expired"))
          && chunk >= 1) {
        // Nothing is received for a finished upload any more: its chunk locks can go. A chunk
        // request still streaming is refused at its record.
        long count = Math.max(1, (descriptor.path("size").asLong() + chunk - 1) / chunk);
        for (int index = 0; index < count; index++)
          try {
            Files.deleteIfExists(directory.resolve(chunkLock(id, index) + ".lock"));
          } catch (IOException ignored) {
          }
      }
    }
  }

  static ObjectNode measure(Path path, int index, Context context) throws Exception {
    MessageDigest digest = hash();
    long size = 0;
    byte[] buffer = new byte[65536];
    try (InputStream input = Files.newInputStream(path)) {
      int count;
      while ((count = input.read(buffer)) != -1) {
        context.check();
        digest.update(buffer, 0, count);
        size += count;
      }
    }
    ObjectNode part =
        JSON.createObjectNode()
            .put("index", index)
            .put("size", size)
            .put("sha256", hex(digest.digest()));
    part.set("reference", JSON.createObjectNode().put("version", 1).put("index", index));
    return part;
  }

  static void removeDirectory(Path directory) throws IOException {
    if (!Files.exists(directory)) return;
    try (var paths = Files.walk(directory)) {
      for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
    }
  }

  public static final class Content implements Storage {
    final Path directory;

    public Content(Path directory) {
      this.directory = directory;
    }

    Path parts(ObjectNode session) throws IOException {
      return directory.resolve("parts").resolve(safe(session.path("id").asText()));
    }

    Path result(ObjectNode session) throws IOException {
      return directory.resolve("files").resolve(safe(session.path("id").asText()));
    }

    public JsonNode begin(ObjectNode session, Context context) throws Exception {
      Files.createDirectories(parts(session));
      return JSON.createObjectNode().put("version", 1).put("id", session.path("id").asText());
    }

    public ObjectNode writePart(
        ObjectNode session, ObjectNode part, InputStream body, Context context) throws Exception {
      int index = part.path("index").asInt();
      Path target = parts(session).resolve(Integer.toString(index));
      if (Files.exists(target)) {
        ObjectNode saved = measure(target, index, context);
        if (saved.path("size").asLong() != part.path("size").asLong()
            || !saved.path("sha256").equals(part.path("sha256")))
          throw fail(409, "PART_CONFLICT", "Chunk contains different data");
      }
      Path temp = Files.createTempFile(parts(session), ".part-", ".tmp");
      try {
        MessageDigest digest = hash();
        long size = 0;
        byte[] buffer = new byte[65536];
        try (OutputStream output = Files.newOutputStream(temp)) {
          int count;
          while ((count = body.read(buffer)) != -1) {
            context.check();
            size += count;
            if (size > part.path("size").asLong())
              throw fail(413, "PART_SIZE", "Chunk exceeds expected size");
            digest.update(buffer, 0, count);
            output.write(buffer, 0, count);
          }
        }
        if (size != part.path("size").asLong()
            || !hex(digest.digest()).equals(part.path("sha256").asText()))
          throw fail(422, "CHECKSUM", "Chunk checksum does not match");
        try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
          channel.force(true);
        }
        Files.move(
            temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        ObjectNode saved = part.deepCopy();
        saved.set("reference", JSON.createObjectNode().put("version", 1).put("index", index));
        atomic(target.resolveSibling(index + ".receipt.json"), saved);
        return saved;
      } finally {
        Files.deleteIfExists(temp);
      }
    }

    public List<ObjectNode> probe(ObjectNode session, Context context) throws Exception {
      List<ObjectNode> parts = new ArrayList<>();
      Path directory = parts(session);
      if (!Files.exists(directory)) return parts;
      try (var files = Files.list(directory)) {
        for (Path path : files.toList()) {
          String name = path.getFileName().toString();
          if (!name.matches("\\d+")) continue;
          int index = Integer.parseInt(name);
          Path receipt = path.resolveSibling(name + ".receipt.json");
          ObjectNode part;
          if (Files.exists(receipt)) part = (ObjectNode) JSON.readTree(Files.readAllBytes(receipt));
          else {
            part = measure(path, index, context);
            atomic(receipt, part);
          }
          if (part.path("size").asLong() != Files.size(path))
            throw fail(500, "STORAGE_CHECKPOINT", "Stored chunk changed");
          parts.add(part);
        }
      }
      parts.sort(Comparator.comparingInt(part -> part.path("index").asInt()));
      return parts;
    }

    public JsonNode inspectResult(ObjectNode session, Context context) throws Exception {
      Path result = result(session);
      if (!Files.exists(result)) return null;
      ObjectNode saved = measure(result, 0, context);
      if (saved.path("size").asLong() != session.path("descriptor").path("size").asLong())
        throw fail(500, "RESULT_SIZE", "Completed file size does not match");
      return JSON.createObjectNode()
          .put("id", session.path("id").asText())
          .put("size", saved.path("size").asLong())
          .put("sha256", saved.path("sha256").asText());
    }

    public JsonNode finish(ObjectNode session, List<ObjectNode> parts, Context context)
        throws Exception {
      JsonNode existing = inspectResult(session, context);
      if (existing != null) return existing;
      Path target = result(session);
      Files.createDirectories(target.getParent());
      Path temp = Files.createTempFile(target.getParent(), ".result-", ".tmp");
      try {
        MessageDigest digest = hash();
        long total = 0;
        byte[] buffer = new byte[65536];
        try (OutputStream output = Files.newOutputStream(temp)) {
          for (ObjectNode part : parts) {
            MessageDigest partHash = hash();
            long size = 0;
            try (InputStream input =
                Files.newInputStream(
                    parts(session).resolve(Integer.toString(part.path("index").asInt())))) {
              int count;
              while ((count = input.read(buffer)) != -1) {
                context.check();
                digest.update(buffer, 0, count);
                partHash.update(buffer, 0, count);
                output.write(buffer, 0, count);
                size += count;
              }
            }
            if (size != part.path("size").asLong()
                || !hex(partHash.digest()).equals(part.path("sha256").asText()))
              throw fail(422, "CHECKSUM", "Saved chunk changed");
            total += size;
          }
        }
        if (total != session.path("descriptor").path("size").asLong())
          throw fail(422, "SIZE", "Assembled size does not match");
        try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
          channel.force(true);
        }
        Files.move(
            temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        removeDirectory(parts(session));
        return JSON.createObjectNode()
            .put("id", session.path("id").asText())
            .put("size", total)
            .put("sha256", hex(digest.digest()));
      } finally {
        Files.deleteIfExists(temp);
      }
    }

    public void abort(ObjectNode session, Context context) throws Exception {
      removeDirectory(parts(session));
    }
  }
}
