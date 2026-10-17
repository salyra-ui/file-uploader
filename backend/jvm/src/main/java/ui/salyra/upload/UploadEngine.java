package ui.salyra.upload;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.io.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * One JVM engine is shared by Java, Kotlin and Scala integrations. No HTTP server starts on import.
 */
public final class UploadEngine {
  public static final ObjectMapper JSON = new ObjectMapper();

  public static final class UploadException extends IOException {
    public final int status;
    public final String code;

    public UploadException(int status, String code, String message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  public record Context(Object application, AtomicBoolean canceled) {
    public Context() {
      this(null, new AtomicBoolean());
    }

    public void check() throws IOException {
      if (canceled.get() || Thread.currentThread().isInterrupted())
        throw new UploadException(499, "ABORT", "Request stopped");
    }
  }

  public interface SessionStore {
    AutoCloseable lock(String id, Context context) throws Exception;

    ObjectNode get(String id) throws Exception;

    void save(ObjectNode session) throws Exception;
  }

  public interface Storage {
    JsonNode begin(ObjectNode session, Context context) throws Exception;

    ObjectNode writePart(ObjectNode session, ObjectNode part, InputStream body, Context context)
        throws Exception;

    List<ObjectNode> probe(ObjectNode session, Context context) throws Exception;

    JsonNode inspectResult(ObjectNode session, Context context) throws Exception;

    JsonNode finish(ObjectNode session, List<ObjectNode> parts, Context context) throws Exception;

    void abort(ObjectNode session, Context context) throws Exception;
  }

  @FunctionalInterface
  public interface Authorize {
    void apply(String operation, ObjectNode session, Context context) throws Exception;
  }

  @FunctionalInterface
  public interface Validate {
    void apply(ObjectNode descriptor, Context context) throws Exception;
  }

  @FunctionalInterface
  public interface Scope {
    String apply(Context context);
  }

  @FunctionalInterface
  public interface Notify {
    void apply(String eventId, String type, ObjectNode session, ObjectNode part, Context context)
        throws Exception;
  }

  public static final class Options {
    public long ttlMillis = 86400000L,
        maxFileSize = 9007199254740991L,
        maxChunkSize = 64L * 1024 * 1024;
    /** Without it, anyone who reaches the routes can create, read and finish uploads. */
    public Authorize authorize;
    /** Allows an engine without authorize (local demos, tests). */
    public boolean allowAnonymous;
    public Validate validate = (descriptor, context) -> {};
    public Scope scope = context -> "";
    public Notify notify = (id, type, session, part, context) -> {};
    public java.util.function.Consumer<Exception> onNotificationError = error -> {};
  }

  public final SessionStore sessions;
  public final Storage storage;
  public final Options options;

  public UploadEngine(SessionStore sessions, Storage storage) {
    this(sessions, storage, new Options());
  }

  public UploadEngine(SessionStore sessions, Storage storage, Options options) {
    if (options.authorize == null && !options.allowAnonymous)
      throw new IllegalArgumentException(
          "Provide authorize (and scope) from your authentication, or allowAnonymous for a local demo");
    this.sessions = sessions;
    this.storage = storage;
    this.options = options;
  }

  static UploadException fail(int status, String code, String message) {
    return new UploadException(status, code, message);
  }

  static String hex(byte[] bytes) {
    return HexFormat.of().formatHex(bytes);
  }

  static MessageDigest hash() throws NoSuchAlgorithmException {
    return MessageDigest.getInstance("SHA-256");
  }

  static int count(JsonNode descriptor) {
    long size = descriptor.path("size").asLong(), chunk = descriptor.path("chunkSize").asLong();
    return (int) Math.max(1, (size + chunk - 1) / chunk);
  }

  void notify(String type, ObjectNode session, ObjectNode part, Context context) {
    try {
      options.notify.apply(
          session.path("id").asText()
              + ":"
              + type
              + (part == null ? "" : ":" + part.path("index").asInt()),
          type,
          session,
          part,
          context);
    } catch (Exception error) {
      options.onNotificationError.accept(error);
    }
  }

  public ObjectNode createUpload(ObjectNode descriptor, String key, Context context)
      throws Exception {
    if (options.authorize != null) options.authorize.apply("create", null, context);
    boolean numbers = true;
    for (String field : List.of("size", "lastModified", "chunkSize")) {
      JsonNode value = descriptor.get(field);
      if (value == null
          || !value.isIntegralNumber()
          || !value.canConvertToLong()
          || value.asLong() < 0
          || value.asLong() > 9007199254740991L) numbers = false;
    }
    if (!numbers
        || !descriptor.path("protocol").asText().equals("salyra-upload/1")
        || !descriptor.path("name").isTextual()
        || !descriptor.path("type").isTextual()
        || descriptor
                .path("name")
                .asText()
                .codePointCount(0, descriptor.path("name").asText().length())
            > 1024
        || descriptor.path("chunkSize").asLong() < 1
        || descriptor.path("chunkSize").asLong() > options.maxChunkSize
        || key.isEmpty()
        || key.length() > 200) throw fail(400, "DESCRIPTOR", "Invalid upload configuration");
    if (descriptor.path("size").asLong() > options.maxFileSize
        || Math.ceil(
                (double) descriptor.path("size").asLong() / descriptor.path("chunkSize").asLong())
            > 100000) throw fail(413, "FILE_SIZE", "File exceeds its limit");
    options.validate.apply(descriptor, context);
    String id =
        hex(hash().digest(JSON.writeValueAsBytes(List.of(options.scope.apply(context), key))));
    try (AutoCloseable lease = sessions.lock(id, context)) {
      ObjectNode existing = sessions.get(id);
      if (existing != null) {
        if (options.authorize != null) options.authorize.apply("create", existing, context);
        if (!existing.path("descriptor").equals(descriptor))
          throw fail(409, "KEY_CONFLICT", "Key belongs to another file");
        if (existing.path("expiresAt").asLong() <= System.currentTimeMillis()
            && existing.path("state").asText().equals("finalizing"))
          reconcile(existing, context);
        if (existing.path("expiresAt").asLong() <= System.currentTimeMillis()
            && !existing.path("state").asText().equals("completed"))
          throw fail(410, "EXPIRED", "Session expired");
        return JSON.createObjectNode()
            .put("id", id)
            .put("chunkSize", descriptor.path("chunkSize").asLong())
            .put("expiresAt", existing.path("expiresAt").asLong());
      }
      ObjectNode session =
          JSON.createObjectNode()
              .put("id", id)
              .put("expiresAt", System.currentTimeMillis() + options.ttlMillis)
              .put("state", "open");
      session.set("descriptor", descriptor.deepCopy());
      session.set("parts", JSON.createArrayNode());
      session.set("storageRef", storage.begin(session, context));
      sessions.save(session);
      notify("created", session, null, context);
      return JSON.createObjectNode()
          .put("id", id)
          .put("chunkSize", descriptor.path("chunkSize").asLong())
          .put("expiresAt", session.path("expiresAt").asLong());
    }
  }

  ObjectNode get(String id, String operation, Context context) throws Exception {
    ObjectNode session = sessions.get(id);
    if (session == null) throw fail(404, "NOT_FOUND", "Upload session was not found");
    if (options.authorize != null) options.authorize.apply(operation, session, context);
    String state = session.path("state").asText();
    if (state.equals("expired")) throw fail(410, "EXPIRED", "Session expired");
    if (session.path("expiresAt").asLong() <= System.currentTimeMillis()
        && !List.of("completed", "canceled").contains(state)) {
      if (state.equals("finalizing")) {
        reconcile(session, context);
        if (session.path("state").asText().equals("completed")) return session;
      }
      storage.abort(session, context);
      session.put("state", "expired");
      sessions.save(session);
      notify("expired", session, null, context);
      throw fail(410, "EXPIRED", "Session expired");
    }
    return session;
  }

  void reconcile(ObjectNode session, Context context) throws Exception {
    if (List.of("completed", "canceled").contains(session.path("state").asText())) return;
    JsonNode result = storage.inspectResult(session, context);
    if (result != null) {
      session.put("state", "completed");
      session.set("result", result);
    } else {
      List<ObjectNode> parts = storage.probe(session, context);
      parts.sort(Comparator.comparingInt(part -> part.path("index").asInt()));
      Set<Integer> seen = new HashSet<>();
      JsonNode descriptor = session.path("descriptor");
      long chunk = descriptor.path("chunkSize").asLong(), size = descriptor.path("size").asLong();
      for (ObjectNode part : parts) {
        int index = part.path("index").asInt();
        if (index < 0
            || index >= count(descriptor)
            || !seen.add(index)
            || part.path("size").asLong() != Math.min(chunk, size - index * chunk))
          throw fail(500, "STORAGE_CHECKPOINT", "Storage returned an invalid part");
      }
      session.set("parts", JSON.valueToTree(parts));
    }
    sessions.save(session);
  }

  public ObjectNode getUpload(String id, Context context) throws Exception {
    try (AutoCloseable lease = sessions.lock(id, context)) {
      ObjectNode session = get(id, "probe", context);
      reconcile(session, context);
      ArrayNode parts = JSON.createArrayNode();
      for (JsonNode part : session.path("parts")) {
        ObjectNode receipt = part.deepCopy();
        receipt.remove("reference");
        parts.add(receipt);
      }
      ObjectNode result =
          JSON.createObjectNode()
              .put("status", session.path("state").asText())
              .put("expiresAt", session.path("expiresAt").asLong());
      result.set("parts", parts);
      if (session.path("state").asText().equals("completed"))
        result.set("result", session.get("result"));
      return result;
    }
  }

  public ObjectNode receivePart(
      String id, int index, String checksum, InputStream body, Context context) throws Exception {
    try (AutoCloseable lease = sessions.lock(id, context)) {
      ObjectNode session = get(id, "part", context);
      if (!session.path("state").asText().equals("open"))
        throw fail(409, "STATE", "Upload does not accept chunks");
      JsonNode descriptor = session.path("descriptor");
      if (index < 0 || index >= count(descriptor) || !checksum.matches("[a-f0-9]{64}"))
        throw fail(400, "PART", "Invalid chunk or checksum");
      long chunk = descriptor.path("chunkSize").asLong();
      ObjectNode part =
          JSON.createObjectNode()
              .put("index", index)
              .put("size", Math.min(chunk, descriptor.path("size").asLong() - index * chunk))
              .put("sha256", checksum);
      ObjectNode saved = storage.writePart(session, part, body, context);
      List<ObjectNode> parts = new ArrayList<>();
      for (JsonNode previous : session.path("parts"))
        if (previous.path("index").asInt() != index) parts.add((ObjectNode) previous);
      parts.add(saved);
      parts.sort(Comparator.comparingInt(p -> p.path("index").asInt()));
      session.set("parts", JSON.valueToTree(parts));
      sessions.save(session);
      notify("part-stored", session, saved, context);
      ObjectNode receipt = saved.deepCopy();
      receipt.remove("reference");
      return receipt;
    }
  }

  public JsonNode finishUpload(String id, Context context) throws Exception {
    try (AutoCloseable lease = sessions.lock(id, context)) {
      ObjectNode session = get(id, "complete", context);
      reconcile(session, context);
      if (session.path("state").asText().equals("completed")) return session.get("result");
      if (session.path("state").asText().equals("canceled"))
        throw fail(409, "CANCELED", "Upload was canceled");
      List<ObjectNode> parts = new ArrayList<>();
      for (JsonNode part : session.path("parts")) parts.add((ObjectNode) part);
      if (parts.size() != count(session.path("descriptor")))
        throw fail(409, "INCOMPLETE", "Upload is missing chunks");
      for (int i = 0; i < parts.size(); i++)
        if (parts.get(i).path("index").asInt() != i)
          throw fail(409, "MANIFEST", "Invalid part manifest");
      session.put("state", "finalizing");
      sessions.save(session);
      JsonNode result;
      try {
        result = storage.finish(session, parts, context);
      } catch (Exception error) {
        result = storage.inspectResult(session, context);
        if (result == null) throw error;
      }
      session.put("state", "completed");
      session.set("result", result);
      sessions.save(session);
      notify("completed", session, null, context);
      return result;
    }
  }

  public void cancelUpload(String id, Context context) throws Exception {
    try (AutoCloseable lease = sessions.lock(id, context)) {
      ObjectNode session = get(id, "cancel", context);
      reconcile(session, context);
      if (session.path("state").asText().equals("completed"))
        throw fail(409, "COMPLETED", "Remove completed files through the application");
      storage.abort(session, context);
      session.put("state", "canceled");
      session.set("parts", JSON.createArrayNode());
      sessions.save(session);
      notify("canceled", session, null, context);
    }
  }
}
