#define _POSIX_C_SOURCE 200809L
#include "internal.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

struct upload_disk {
  char *directory;
};
static int path(upload_disk *disk, char *out, size_t capacity, const char *area,
                const char *id, const char *suffix, upload_error *error) {
  if (!u_safe(id))
    return u_error(error, 400, "ID", "Invalid upload identifier");
  if (snprintf(out, capacity, "%s/%s/%s%s", disk->directory, area, id,
               suffix) >= (int)capacity)
    return u_error(error, 500, "PATH", "Storage path is too long");
  return 0;
}
static int mkdirs(const char *directory) {
  char *copy = upload_copy(directory);
  if (!copy)
    return -1;
  for (char *p = copy + 1; *p; p++) {
    if (*p == '/') {
      *p = 0;
      if (mkdir(copy, 0700) && errno != EEXIST) {
        free(copy);
        return -1;
      }
      *p = '/';
    }
  }
  int rc = mkdir(copy, 0700);
  free(copy);
  return rc && errno != EEXIST ? -1 : 0;
}
static int io_error(upload_error *error) {
  return u_error(error, 500, "STORAGE_IO", "Filesystem operation failed");
}
static int write_all(int fd, const unsigned char *bytes, size_t size) {
  while (size) {
    ssize_t n = write(fd, bytes, size);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      return -1;
    bytes += n;
    size -= (size_t)n;
  }
  return 0;
}
static int atomic(const char *destination, const char *text,
                  upload_error *error) {
  char temporary[4096];
  if (snprintf(temporary, sizeof(temporary), "%s.XXXXXX", destination) >=
      (int)sizeof(temporary))
    return io_error(error);
  int fd = mkstemp(temporary);
  if (fd < 0)
    return io_error(error);
  int failed =
      write_all(fd, (const unsigned char *)text, strlen(text)) || fsync(fd);
  if (close(fd))
    failed = 1;
  if (!failed && rename(temporary, destination))
    failed = 1;
  if (failed) {
    unlink(temporary);
    return io_error(error);
  }
  return 0;
}
static int read_json(const char *filename, char **out, upload_error *error) {
  *out = NULL;
  int fd = open(filename, O_RDONLY);
  if (fd < 0)
    return errno == ENOENT ? 0 : io_error(error);
  struct stat st;
  if (fstat(fd, &st) || st.st_size < 0 || st.st_size > 16 * 1024 * 1024) {
    close(fd);
    return io_error(error);
  }
  char *data = malloc((size_t)st.st_size + 1);
  if (!data) {
    close(fd);
    return u_error(error, 500, "MEMORY", "Allocation failed");
  }
  size_t position = 0;
  while (position < (size_t)st.st_size) {
    ssize_t n = read(fd, data + position, (size_t)st.st_size - position);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0) {
      free(data);
      close(fd);
      return io_error(error);
    }
    position += (size_t)n;
  }
  close(fd);
  data[position] = 0;
  *out = data;
  return 0;
}
static int measure(const char *filename, int64_t *size, char hash[65],
                   upload_error *error) {
  int fd = open(filename, O_RDONLY);
  if (fd < 0)
    return errno == ENOENT ? 404 : io_error(error);
  EVP_MD_CTX *digest = EVP_MD_CTX_new();
  if (!digest) {
    close(fd);
    return io_error(error);
  }
  EVP_DigestInit_ex(digest, EVP_sha256(), NULL);
  unsigned char buffer[65536], bytes[32];
  unsigned int length;
  *size = 0;
  int status = 0;
  for (;;) {
    ssize_t n = read(fd, buffer, sizeof(buffer));
    if (n < 0 && errno == EINTR)
      continue;
    if (n < 0) {
      status = io_error(error);
      break;
    }
    if (!n)
      break;
    *size += n;
    EVP_DigestUpdate(digest, buffer, (size_t)n);
  }
  if (!status) {
    EVP_DigestFinal_ex(digest, bytes, &length);
    u_hex(bytes, 32, hash);
  }
  EVP_MD_CTX_free(digest);
  close(fd);
  return status;
}
static int lock_session(void *data, const char *id, void **lease,
                        upload_error *error) {
  char filename[4096];
  int status =
      path(data, filename, sizeof(filename), "locks", id, ".lock", error);
  if (status)
    return status;
  int fd = open(filename, O_CREAT | O_RDWR, 0600);
  if (fd < 0)
    return io_error(error);
  while (flock(fd, LOCK_EX)) {
    if (errno != EINTR) {
      close(fd);
      return io_error(error);
    }
  }
  int *owned = malloc(sizeof(int));
  if (!owned) {
    close(fd);
    return io_error(error);
  }
  *owned = fd;
  *lease = owned;
  return 0;
}
static void unlock_session(void *data, void *lease) {
  (void)data;
  if (!lease)
    return;
  int fd = *(int *)lease;
  flock(fd, LOCK_UN);
  close(fd);
  free(lease);
}
static int get_session(void *data, const char *id, char **out,
                       upload_error *error) {
  char filename[4096];
  int status =
      path(data, filename, sizeof(filename), "sessions", id, ".json", error);
  return status ? status : read_json(filename, out, error);
}
/* Nothing is received for a finished upload any more: its chunk locks can go. A
 * chunk request still streaming is refused at its record. */
static void drop_chunk_locks(void *data, const char *json) {
  cJSON *session = cJSON_Parse(json);
  const char *state = u_string(session, "state");
  cJSON *descriptor = cJSON_GetObjectItemCaseSensitive(session, "descriptor");
  int64_t size = u_number(descriptor, "size"),
          chunk = u_number(descriptor, "chunkSize");
  if (chunk >= 1 && size >= 0 &&
      (!strcmp(state, "completed") || !strcmp(state, "canceled") ||
       !strcmp(state, "expired"))) {
    int64_t count = (size + chunk - 1) / chunk;
    for (int64_t index = 0; index < (count ? count : 1); index++) {
      char key[160], filename[4096];
      snprintf(key, sizeof(key), "%s-part-%lld", u_string(session, "id"),
               (long long)index);
      if (!path(data, filename, sizeof(filename), "locks", key, ".lock", NULL))
        unlink(filename);
    }
  }
  cJSON_Delete(session);
}
static int put_session(void *data, const char *id, const char *json,
                       upload_error *error) {
  char filename[4096];
  int status =
      path(data, filename, sizeof(filename), "sessions", id, ".json", error);
  if (!status)
    status = atomic(filename, json, error);
  if (!status)
    drop_chunk_locks(data, json);
  return status;
}
static int part_path(upload_disk *disk, const cJSON *session, int index,
                     const char *suffix, char out[4096], upload_error *error) {
  char tail[64];
  snprintf(tail, sizeof(tail), "/%d%s", index, suffix);
  return path(disk, out, 4096, "parts", u_string(session, "id"), tail, error);
}
static int begin(void *data, const char *session_json, void *context,
                 char **out, upload_error *error) {
  (void)context;
  cJSON *session = cJSON_Parse(session_json);
  char directory[4096];
  int status = path(data, directory, sizeof(directory), "parts",
                    u_string(session, "id"), "", error);
  if (!status && mkdirs(directory))
    status = io_error(error);
  if (!status)
    *out = upload_copy("{}");
  cJSON_Delete(session);
  return status;
}
static int write_part(void *data, const char *session_json,
                      const char *part_json, upload_read source, void *body,
                      void *context, char **out, upload_error *error) {
  (void)context;
  *out = NULL;
  cJSON *session = cJSON_Parse(session_json), *part = cJSON_Parse(part_json);
  char filename[4096], temporary[4096], receipt_path[4096];
  int index = (int)u_number(part, "index"),
      status = part_path(data, session, index, ".part", filename, error);
  if (status)
    goto done;
  status = part_path(data, session, index, ".json", receipt_path, error);
  if (status)
    goto done;
  char *existing = NULL;
  status = read_json(receipt_path, &existing, error);
  if (status)
    goto done;
  if (existing) {
    cJSON *receipt = cJSON_Parse(existing);
    free(existing);
    int different =
        u_number(receipt, "size") != u_number(part, "size") ||
        strcmp(u_string(receipt, "sha256"), u_string(part, "sha256"));
    cJSON_Delete(receipt);
    if (different) {
      status = u_error(error, 409, "PART_CONFLICT",
                       "Chunk already contains different bytes");
      goto done;
    }
  }
  if (snprintf(temporary, sizeof(temporary), "%s.XXXXXX", filename) >=
      (int)sizeof(temporary)) {
    status = io_error(error);
    goto done;
  }
  int fd = mkstemp(temporary);
  if (fd < 0) {
    status = io_error(error);
    goto done;
  }
  unsigned char buffer[65536];
  for (;;) {
    long n = source(body, buffer, sizeof(buffer));
    if (n < 0) {
      status = error && error->status
                   ? error->status
                   : u_error(error, 400, "BODY", "Body read failed");
      break;
    }
    if (!n)
      break;
    if (write_all(fd, buffer, (size_t)n)) {
      status = io_error(error);
      break;
    }
  }
  if (!status && fsync(fd))
    status = io_error(error);
  if (close(fd) && !status)
    status = io_error(error);
  if (!status && rename(temporary, filename))
    status = io_error(error);
  if (status) {
    unlink(temporary);
    goto done;
  }
  char *receipt = u_json(part);
  status = atomic(receipt_path, receipt, error);
  if (!status)
    *out = receipt;
  else
    free(receipt);
done:
  cJSON_Delete(session);
  cJSON_Delete(part);
  return status;
}
static int probe(void *data, const char *session_json, void *context,
                 char **out, upload_error *error) {
  (void)context;
  *out = NULL;
  cJSON *session = cJSON_Parse(session_json),
        *descriptor = cJSON_GetObjectItemCaseSensitive(session, "descriptor"),
        *parts = cJSON_CreateArray();
  int64_t size = u_number(descriptor, "size"),
          chunk = u_number(descriptor, "chunkSize"),
          count = (size + chunk - 1) / chunk;
  if (!count)
    count = 1;
  int status = 0;
  for (int i = 0; i < count; i++) {
    char filename[4096], receipt_path[4096];
    status = part_path(data, session, i, ".part", filename, error);
    if (status)
      break;
    struct stat st;
    if (stat(filename, &st)) {
      if (errno == ENOENT)
        continue;
      status = io_error(error);
      break;
    }
    status = part_path(data, session, i, ".json", receipt_path, error);
    if (status)
      break;
    char *json = NULL;
    status = read_json(receipt_path, &json, error);
    if (status)
      break;
    cJSON *receipt = json ? cJSON_Parse(json) : NULL;
    free(json);
    if (!receipt || u_number(receipt, "size") != st.st_size) {
      cJSON_Delete(receipt);
      int64_t measured;
      char hash[65];
      status = measure(filename, &measured, hash, error);
      if (status)
        break;
      receipt = cJSON_CreateObject();
      cJSON_AddNumberToObject(receipt, "index", i);
      cJSON_AddNumberToObject(receipt, "size", (double)measured);
      cJSON_AddStringToObject(receipt, "sha256", hash);
      json = u_json(receipt);
      status = atomic(receipt_path, json, error);
      free(json);
      if (status) {
        cJSON_Delete(receipt);
        break;
      }
    }
    cJSON_AddItemToArray(parts, receipt);
  }
  if (!status)
    *out = u_json(parts);
  cJSON_Delete(parts);
  cJSON_Delete(session);
  return status;
}
static int inspect(void *data, const char *session_json, void *context,
                   char **out, upload_error *error) {
  (void)context;
  *out = NULL;
  cJSON *session = cJSON_Parse(session_json);
  char filename[4096], hash[65];
  int status = path(data, filename, sizeof(filename), "files",
                    u_string(session, "id"), "", error);
  int64_t size = 0;
  if (!status)
    status = measure(filename, &size, hash, error);
  if (status == 404)
    status = 0;
  else if (!status) {
    if (size !=
        u_number(cJSON_GetObjectItemCaseSensitive(session, "descriptor"),
                 "size"))
      status = u_error(error, 500, "FINAL_SIZE",
                       "Completed file has an invalid size");
    else {
      cJSON *value = cJSON_CreateObject();
      cJSON_AddStringToObject(value, "id", u_string(session, "id"));
      cJSON_AddNumberToObject(value, "size", (double)size);
      cJSON_AddStringToObject(value, "sha256", hash);
      *out = u_json(value);
      cJSON_Delete(value);
    }
  }
  cJSON_Delete(session);
  return status;
}
static int abort_parts(void *data, const char *session_json, void *context,
                       upload_error *error) {
  (void)context;
  cJSON *session = cJSON_Parse(session_json);
  char directory[4096];
  int status = path(data, directory, sizeof(directory), "parts",
                    u_string(session, "id"), "", error);
  if (status) {
    cJSON_Delete(session);
    return status;
  }
  DIR *dir = opendir(directory);
  if (!dir) {
    cJSON_Delete(session);
    return errno == ENOENT ? 0 : io_error(error);
  }
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
      continue;
    char filename[8192];
    snprintf(filename, sizeof(filename), "%s/%s", directory, entry->d_name);
    if (unlink(filename) && errno != ENOENT) {
      status = io_error(error);
      break;
    }
  }
  closedir(dir);
  if (!status && rmdir(directory) && errno != ENOENT)
    status = io_error(error);
  cJSON_Delete(session);
  return status;
}
static int finish(void *data, const char *session_json,
                  const char *manifest_json, void *context, char **out,
                  upload_error *error) {
  *out = NULL;
  cJSON *session = cJSON_Parse(session_json),
        *manifest = cJSON_Parse(manifest_json);
  char destination[4096], temporary[4096];
  int status = path(data, destination, sizeof(destination), "files",
                    u_string(session, "id"), "", error);
  if (status)
    goto done;
  if (snprintf(temporary, sizeof(temporary), "%s.XXXXXX", destination) >=
      (int)sizeof(temporary)) {
    status = io_error(error);
    goto done;
  }
  int target = mkstemp(temporary);
  if (target < 0) {
    status = io_error(error);
    goto done;
  }
  cJSON *part;
  int64_t total = 0;
  cJSON_ArrayForEach(part, manifest) {
    char filename[4096];
    status = part_path(data, session, (int)u_number(part, "index"), ".part",
                       filename, error);
    if (status)
      break;
    int source = open(filename, O_RDONLY);
    if (source < 0) {
      status = io_error(error);
      break;
    }
    EVP_MD_CTX *digest = EVP_MD_CTX_new();
    if (!digest) {
      close(source);
      status = io_error(error);
      break;
    }
    EVP_DigestInit_ex(digest, EVP_sha256(), NULL);
    unsigned char buffer[65536], bytes[32];
    unsigned int length;
    int64_t size = 0;
    for (;;) {
      ssize_t n = read(source, buffer, sizeof(buffer));
      if (n < 0 && errno == EINTR)
        continue;
      if (n < 0) {
        status = io_error(error);
        break;
      }
      if (!n)
        break;
      size += n;
      EVP_DigestUpdate(digest, buffer, (size_t)n);
      if (write_all(target, buffer, (size_t)n)) {
        status = io_error(error);
        break;
      }
    }
    close(source);
    EVP_DigestFinal_ex(digest, bytes, &length);
    EVP_MD_CTX_free(digest);
    char hash[65];
    u_hex(bytes, 32, hash);
    if (!status && (size != u_number(part, "size") ||
                    strcmp(hash, u_string(part, "sha256"))))
      status = u_error(error, 422, "CHECKSUM",
                       "Stored chunk checksum does not match");
    total += size;
    if (status)
      break;
  }
  if (!status &&
      total != u_number(cJSON_GetObjectItemCaseSensitive(session, "descriptor"),
                        "size"))
    status =
        u_error(error, 422, "FINAL_SIZE", "Combined file has an invalid size");
  if (!status && fsync(target))
    status = io_error(error);
  if (close(target) && !status)
    status = io_error(error);
  if (!status && rename(temporary, destination))
    status = io_error(error);
  if (status) {
    unlink(temporary);
    goto done;
  }
  status = inspect(data, session_json, context, out, error);
  if (!status)
    status = abort_parts(data, session_json, context, error);
done:
  cJSON_Delete(session);
  cJSON_Delete(manifest);
  return status;
}
upload_disk *upload_disk_new(const char *directory) {
  if (!directory || !*directory)
    return NULL;
  upload_disk *disk = calloc(1, sizeof(*disk));
  if (!disk)
    return NULL;
  disk->directory = upload_copy(directory);
  if (!disk->directory) {
    free(disk);
    return NULL;
  }
  const char *areas[] = {"sessions", "locks", "parts", "files"};
  for (int i = 0; i < 4; i++) {
    char path[4096];
    if (snprintf(path, sizeof(path), "%s/%s", directory, areas[i]) >=
            (int)sizeof(path) ||
        mkdirs(path)) {
      upload_disk_free(disk);
      return NULL;
    }
  }
  return disk;
}
void upload_disk_free(upload_disk *disk) {
  if (disk) {
    free(disk->directory);
    free(disk);
  }
}
upload_session_store upload_disk_sessions(upload_disk *disk) {
  upload_session_store result = {disk, lock_session, unlock_session,
                                 get_session, put_session};
  return result;
}
upload_storage upload_disk_storage(upload_disk *disk) {
  upload_storage result = {disk,    begin,  write_part, probe,
                           inspect, finish, abort_parts};
  return result;
}
