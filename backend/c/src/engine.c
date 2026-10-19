#define _POSIX_C_SOURCE 200809L
#include "internal.h"
#include <time.h>
struct upload_engine {
  upload_options options;
};
int u_error(upload_error *error, int status, const char *code,
            const char *message) {
  if (error) {
    error->status = status;
    error->code = code;
    error->message = message;
  }
  return status;
}
char *upload_copy(const char *text) {
  if (!text)
    return NULL;
  size_t length = strlen(text) + 1;
  char *copy = malloc(length);
  if (copy)
    memcpy(copy, text, length);
  return copy;
}
void upload_free(void *memory) { free(memory); }
void u_hex(const unsigned char *bytes, size_t length, char *out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < length; i++) {
    out[2 * i] = digits[bytes[i] >> 4];
    out[2 * i + 1] = digits[bytes[i] & 15];
  }
  out[length * 2] = 0;
}
int u_safe(const char *id) {
  if (!id || !*id || strlen(id) > 100)
    return 0;
  for (const char *p = id; *p; p++)
    if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
          (*p >= '0' && *p <= '9') || *p == '-' || *p == '_'))
      return 0;
  return 1;
}
const char *u_string(const cJSON *node, const char *key) {
  cJSON *value = cJSON_GetObjectItemCaseSensitive(node, key);
  return cJSON_IsString(value) ? value->valuestring : "";
}
int64_t u_number(const cJSON *node, const char *key) {
  cJSON *value = cJSON_GetObjectItemCaseSensitive(node, key);
  return cJSON_IsNumber(value) && isfinite(value->valuedouble) &&
                 value->valuedouble >= 0 &&
                 value->valuedouble <= 9007199254740991.0 &&
                 floor(value->valuedouble) == value->valuedouble
             ? (int64_t)value->valuedouble
             : -1;
}
char *u_json(cJSON *node) { return cJSON_PrintUnformatted(node); }
static uint64_t now(void) {
  struct timespec clock;
  clock_gettime(CLOCK_REALTIME, &clock);
  return (uint64_t)clock.tv_sec * 1000 + clock.tv_nsec / 1000000;
}
static int64_t count(const cJSON *descriptor) {
  int64_t size = u_number(descriptor, "size"),
          chunk = u_number(descriptor, "chunkSize");
  return chunk > 0
             ? ((size + chunk - 1) / chunk > 0 ? (size + chunk - 1) / chunk : 1)
             : 0;
}
static void replace(cJSON *node, const char *key, cJSON *value) {
  cJSON_DeleteItemFromObjectCaseSensitive(node, key);
  cJSON_AddItemToObject(node, key, value);
}
static int authorize(upload_engine *engine, const char *operation,
                     cJSON *session, void *context, upload_error *error) {
  if (!engine->options.authorize)
    return 0;
  char *json = session ? u_json(session) : NULL;
  int status = engine->options.authorize(operation, json, context, error);
  free(json);
  return status;
}
static void notify(upload_engine *engine, const char *type, cJSON *session,
                   void *context) {
  if (!engine->options.notify)
    return;
  char event[160];
  snprintf(event, sizeof(event), "%s:%s", u_string(session, "id"), type);
  char *json = u_json(session);
  engine->options.notify(event, type, json, context);
  free(json);
}
static int save(upload_engine *engine, cJSON *session, upload_error *error) {
  char *json = u_json(session);
  if (!json)
    return u_error(error, 500, "MEMORY", "Allocation failed");
  int status = engine->options.sessions.put(
      engine->options.sessions.data, u_string(session, "id"), json, error);
  free(json);
  return status;
}
upload_engine *upload_engine_new(const upload_options *options) {
  if (!options || !options->sessions.lock || !options->sessions.unlock ||
      !options->sessions.get || !options->sessions.put ||
      !options->storage.begin || !options->storage.write_part ||
      !options->storage.probe || !options->storage.inspect ||
      !options->storage.finish || !options->storage.abort ||
      (!options->authorize && !options->allow_anonymous))
    return NULL;
  upload_engine *engine = calloc(1, sizeof(*engine));
  if (!engine)
    return NULL;
  engine->options = *options;
  if (!engine->options.ttl_milliseconds)
    engine->options.ttl_milliseconds = 86400000;
  if (!engine->options.max_file_size)
    engine->options.max_file_size = 9007199254740991ULL;
  if (!engine->options.max_chunk_size)
    engine->options.max_chunk_size = 64 * 1024 * 1024;
  return engine;
}
void upload_engine_free(upload_engine *engine) { free(engine); }
static int reconcile(upload_engine *engine, cJSON *session, void *context,
                     upload_error *error);
static int get(upload_engine *engine, const char *id, const char *operation,
               void *context, cJSON **out, upload_error *error) {
  char *json = NULL;
  int status = engine->options.sessions.get(engine->options.sessions.data, id,
                                            &json, error);
  if (status)
    return status;
  if (!json)
    return u_error(error, 404, "NOT_FOUND", "Upload session was not found");
  cJSON *session = cJSON_Parse(json);
  free(json);
  if (!session)
    return u_error(error, 500, "SESSION_JSON", "Invalid session data");
  status = authorize(engine, operation, session, context, error);
  if (status) {
    cJSON_Delete(session);
    return status;
  }
  const char *state = u_string(session, "state");
  if (!strcmp(state, "expired")) {
    cJSON_Delete(session);
    return u_error(error, 410, "EXPIRED", "Session expired");
  }
  if ((uint64_t)u_number(session, "expiresAt") <= now() &&
      strcmp(state, "completed") && strcmp(state, "canceled")) {
    if (!strcmp(state, "finalizing")) {
      status = reconcile(engine, session, context, error);
      if (status) { cJSON_Delete(session); return status; }
      if (!strcmp(u_string(session, "state"), "completed")) { *out = session; return 0; }
    }
    char *raw = u_json(session);
    status = engine->options.storage.abort(engine->options.storage.data, raw,
                                           context, error);
    free(raw);
    if (!status) {
      replace(session, "state", cJSON_CreateString("expired"));
      status = save(engine, session, error);
      notify(engine, "expired", session, context);
    }
    cJSON_Delete(session);
    return status ? status : u_error(error, 410, "EXPIRED", "Session expired");
  }
  *out = session;
  return 0;
}
static int reconcile(upload_engine *engine, cJSON *session, void *context,
                     upload_error *error) {
  if (!strcmp(u_string(session, "state"), "completed") ||
      !strcmp(u_string(session, "state"), "canceled"))
    return 0;
  char *raw = u_json(session), *result = NULL;
  int status = engine->options.storage.inspect(engine->options.storage.data,
                                               raw, context, &result, error);
  if (status) {
    free(raw);
    return status;
  }
  if (result) {
    cJSON *value = cJSON_Parse(result);
    free(result);
    if (!value) {
      free(raw);
      return u_error(error, 500, "STORAGE_JSON", "Invalid storage result");
    }
    replace(session, "result", value);
    replace(session, "state", cJSON_CreateString("completed"));
  } else {
    char *parts = NULL;
    status = engine->options.storage.probe(engine->options.storage.data, raw,
                                           context, &parts, error);
    if (status) {
      free(raw);
      return status;
    }
    cJSON *values = cJSON_Parse(parts);
    free(parts);
    if (!cJSON_IsArray(values)) {
      cJSON_Delete(values);
      free(raw);
      return u_error(error, 500, "STORAGE_JSON", "Invalid part manifest");
    }
    replace(session, "parts", values);
  }
  free(raw);
  return save(engine, session, error);
}
int upload_create(upload_engine *engine, const char *descriptor,
                  const char *key, void *context, char **result,
                  upload_error *error) {
  *result = NULL;
  int status = authorize(engine, "create", NULL, context, error);
  if (status)
    return status;
  cJSON *d = cJSON_Parse(descriptor);
  if (!cJSON_IsObject(d) ||
      strcmp(u_string(d, "protocol"), "salyra-upload/1") ||
      !cJSON_IsString(cJSON_GetObjectItemCaseSensitive(d, "name")) ||
      !cJSON_IsString(cJSON_GetObjectItemCaseSensitive(d, "type")) ||
      strlen(u_string(d, "name")) > 4096 || !key || !*key ||
      strlen(key) > 200) {
    cJSON_Delete(d);
    return u_error(error, 400, "DESCRIPTOR", "Invalid upload configuration");
  }
  const char *fields[] = {"size", "lastModified", "chunkSize"};
  for (int i = 0; i < 3; i++) {
    cJSON *value = cJSON_GetObjectItemCaseSensitive(d, fields[i]);
    if (!cJSON_IsNumber(value) || !isfinite(value->valuedouble) ||
        value->valuedouble < 0 || value->valuedouble > 9007199254740991.0 ||
        floor(value->valuedouble) != value->valuedouble) {
      cJSON_Delete(d);
      return u_error(error, 400, "DESCRIPTOR", "Invalid upload configuration");
    }
  }
  if (u_number(d, "chunkSize") < 1 ||
      (uint64_t)u_number(d, "chunkSize") > engine->options.max_chunk_size) {
    cJSON_Delete(d);
    return u_error(error, 400, "DESCRIPTOR", "Invalid chunk size");
  }
  if ((uint64_t)u_number(d, "size") > engine->options.max_file_size ||
      count(d) > 100000) {
    cJSON_Delete(d);
    return u_error(error, 413, "FILE_SIZE", "File exceeds its limit");
  }
  if (engine->options.validate &&
      (status = engine->options.validate(descriptor, context, error))) {
    cJSON_Delete(d);
    return status;
  }
  const char *scope =
      engine->options.scope ? engine->options.scope(context) : "";
  cJSON *identity = cJSON_CreateArray();
  cJSON_AddItemToArray(identity, cJSON_CreateString(scope ? scope : ""));
  cJSON_AddItemToArray(identity, cJSON_CreateString(key));
  char *raw = u_json(identity);
  unsigned char digest[32];
  unsigned int digest_length = 0;
  EVP_Digest(raw, strlen(raw), digest, &digest_length, EVP_sha256(), NULL);
  free(raw);
  cJSON_Delete(identity);
  char id[65];
  u_hex(digest, 32, id);
  void *lease = NULL;
  status = engine->options.sessions.lock(engine->options.sessions.data, id,
                                         &lease, error);
  if (status) {
    cJSON_Delete(d);
    return status;
  }
  char *existing = NULL;
  cJSON *session = NULL;
  status = engine->options.sessions.get(engine->options.sessions.data, id,
                                        &existing, error);
  if (status)
    goto done;
  if (existing) {
    session = cJSON_Parse(existing);
    free(existing);
    if (!session) {
      status = u_error(error, 500, "SESSION_JSON", "Invalid session data");
      goto done;
    }
    status = authorize(engine, "create", session, context, error);
    if (status)
      goto done;
    if (!cJSON_Compare(cJSON_GetObjectItemCaseSensitive(session, "descriptor"),
                       d, 1)) {
      status =
          u_error(error, 409, "KEY_CONFLICT", "Key belongs to another file");
      goto done;
    }
    if ((uint64_t)u_number(session, "expiresAt") <= now() &&
        !strcmp(u_string(session, "state"), "finalizing")) {
      status = reconcile(engine, session, context, error);
      if (status) goto done;
    }
    if ((uint64_t)u_number(session, "expiresAt") <= now() &&
        strcmp(u_string(session, "state"), "completed")) {
      status = u_error(error, 410, "EXPIRED", "Session expired");
      goto done;
    }
  } else {
    session = cJSON_CreateObject();
    cJSON_AddStringToObject(session, "id", id);
    cJSON_AddItemToObject(session, "descriptor", cJSON_Duplicate(d, 1));
    cJSON_AddNumberToObject(session, "expiresAt",
                            (double)(now() + engine->options.ttl_milliseconds));
    cJSON_AddStringToObject(session, "state", "open");
    cJSON_AddArrayToObject(session, "parts");
    char *session_json = u_json(session), *reference = NULL;
    status = engine->options.storage.begin(
        engine->options.storage.data, session_json, context, &reference, error);
    free(session_json);
    if (status)
      goto done;
    cJSON *ref = cJSON_Parse(reference);
    free(reference);
    if (!ref) {
      status = u_error(error, 500, "STORAGE_JSON", "Invalid storage reference");
      goto done;
    }
    cJSON_AddItemToObject(session, "storageRef", ref);
    status = save(engine, session, error);
    if (status)
      goto done;
    notify(engine, "created", session, context);
  }
  cJSON *reply = cJSON_CreateObject();
  cJSON_AddStringToObject(reply, "id", id);
  cJSON_AddNumberToObject(reply, "chunkSize", (double)u_number(d, "chunkSize"));
  cJSON_AddNumberToObject(reply, "expiresAt",
                          (double)u_number(session, "expiresAt"));
  *result = u_json(reply);
  cJSON_Delete(reply);
done:
  cJSON_Delete(d);
  cJSON_Delete(session);
  engine->options.sessions.unlock(engine->options.sessions.data, lease);
  return status;
}
static int start(upload_engine *engine, const char *id, const char *operation,
                 void *context, void **lease, cJSON **session,
                 upload_error *error) {
  if (!u_safe(id))
    return u_error(error, 400, "ID", "Invalid upload identifier");
  int status = engine->options.sessions.lock(engine->options.sessions.data, id,
                                             lease, error);
  if (status)
    return status;
  status = get(engine, id, operation, context, session, error);
  if (status) {
    engine->options.sessions.unlock(engine->options.sessions.data, *lease);
    *lease = NULL;
  }
  return status;
}
int upload_probe(upload_engine *engine, const char *id, void *context,
                 char **result, upload_error *error) {
  *result = NULL;
  void *lease = NULL;
  cJSON *session = NULL;
  int status = start(engine, id, "probe", context, &lease, &session, error);
  if (status)
    return status;
  status = reconcile(engine, session, context, error);
  if (!status) {
    cJSON *reply = cJSON_CreateObject();
    cJSON_AddStringToObject(reply, "status", u_string(session, "state"));
    cJSON_AddNumberToObject(reply, "expiresAt",
                            (double)u_number(session, "expiresAt"));
    cJSON *parts = cJSON_Duplicate(
              cJSON_GetObjectItemCaseSensitive(session, "parts"), 1),
          *part;
    cJSON_ArrayForEach(part, parts)
        cJSON_DeleteItemFromObjectCaseSensitive(part, "reference");
    cJSON_AddItemToObject(reply, "parts", parts);
    if (!strcmp(u_string(session, "state"), "completed"))
      cJSON_AddItemToObject(
          reply, "result",
          cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(session, "result"),
                          1));
    *result = u_json(reply);
    cJSON_Delete(reply);
  }
  cJSON_Delete(session);
  engine->options.sessions.unlock(engine->options.sessions.data, lease);
  return status;
}
struct checked_body {
  upload_read source;
  void *body;
  uint64_t size, expected;
  EVP_MD_CTX *hash;
  const char *sha256;
  upload_error *error;
  int done, failed;
};
static long checked_read(void *data, unsigned char *buffer, size_t capacity) {
  struct checked_body *body = data;
  if (body->failed)
    return -1;
  if (body->done)
    return 0;
  long count = body->source(body->body, buffer, capacity);
  if (count < 0) {
    body->failed = 1;
    u_error(body->error, 400, "BODY", "Body read failed");
    return -1;
  }
  if ((size_t)count > capacity) {
    body->failed = 1;
    u_error(body->error, 500, "READER", "Reader exceeded buffer capacity");
    return -1;
  }
  if (count) {
    body->size += (uint64_t)count;
    if (body->size > body->expected) {
      body->failed = 1;
      u_error(body->error, 413, "PART_SIZE", "Chunk exceeds expected size");
      return -1;
    }
    EVP_DigestUpdate(body->hash, buffer, (size_t)count);
    return count;
  }
  unsigned char bytes[32];
  unsigned int length;
  char hex[65];
  EVP_DigestFinal_ex(body->hash, bytes, &length);
  u_hex(bytes, 32, hex);
  if (body->size != body->expected || strcmp(hex, body->sha256)) {
    body->failed = 1;
    u_error(body->error, 422, "CHECKSUM", "Chunk checksum does not match");
    return -1;
  }
  body->done = 1;
  return 0;
}
/* What the first, locked step of a part learned: the session as it was, the
 * requested part, and a copy of the recorded chunk with this number (NULL when
 * there is none). */
struct part_plan {
  cJSON *session, *part, *existing;
  uint64_t expected;
};
static int plan_part(upload_engine *engine, const char *id, int index,
                     const char *checksum, upload_read source, void *context,
                     struct part_plan *plan, upload_error *error) {
  memset(plan, 0, sizeof(*plan));
  void *lease = NULL;
  int status =
      start(engine, id, "part", context, &lease, &plan->session, error);
  if (status)
    return status;
  cJSON *d = cJSON_GetObjectItemCaseSensitive(plan->session, "descriptor");
  if (strcmp(u_string(plan->session, "state"), "open")) {
    status = u_error(error, 409, "STATE", "Upload does not accept chunks");
    goto done;
  }
  if (index < 0 || index >= count(d) || !checksum || strlen(checksum) != 64 ||
      strspn(checksum, "0123456789abcdef") != 64 || !source) {
    status = u_error(error, 400, "PART", "Invalid chunk or checksum");
    goto done;
  }
  uint64_t chunk = (uint64_t)u_number(d, "chunkSize"),
           remaining = (uint64_t)u_number(d, "size") - (uint64_t)index * chunk;
  plan->expected = remaining < chunk ? remaining : chunk;
  plan->part = cJSON_CreateObject();
  cJSON_AddNumberToObject(plan->part, "index", index);
  cJSON_AddNumberToObject(plan->part, "size", (double)plan->expected);
  cJSON_AddStringToObject(plan->part, "sha256", checksum);
  cJSON *stored;
  cJSON_ArrayForEach(stored,
                     cJSON_GetObjectItemCaseSensitive(plan->session, "parts")) {
    if (u_number(stored, "index") == index)
      plan->existing = cJSON_Duplicate(stored, 1);
  }
done:
  engine->options.sessions.unlock(engine->options.sessions.data, lease);
  if (status) {
    cJSON_Delete(plan->session);
    cJSON_Delete(plan->part);
    cJSON_Delete(plan->existing);
    memset(plan, 0, sizeof(*plan));
  }
  return status;
}
/* A retransmitted body is consumed and checked: a matching header does not
 * prove matching content. */
static int verify_part(const cJSON *existing, const char *checksum,
                       uint64_t expected, upload_read source, void *body,
                       char **result, upload_error *error) {
  EVP_MD_CTX *hash = EVP_MD_CTX_new();
  if (!hash)
    return u_error(error, 500, "MEMORY", "Allocation failed");
  EVP_DigestInit_ex(hash, EVP_sha256(), NULL);
  unsigned char buffer[65536];
  uint64_t size = 0;
  int status = 0;
  for (;;) {
    long got = source(body, buffer, sizeof(buffer));
    if (got < 0) {
      status = u_error(error, 400, "BODY", "Body read failed");
      break;
    }
    if ((size_t)got > sizeof(buffer)) {
      status = u_error(error, 500, "READER", "Reader exceeded buffer capacity");
      break;
    }
    if (!got)
      break;
    size += (uint64_t)got;
    if (size > expected) {
      status = u_error(error, 413, "PART_SIZE", "Chunk exceeds expected size");
      break;
    }
    EVP_DigestUpdate(hash, buffer, (size_t)got);
  }
  if (!status) {
    unsigned char bytes[32];
    unsigned int length;
    char hex[65];
    EVP_DigestFinal_ex(hash, bytes, &length);
    u_hex(bytes, 32, hex);
    const char *recorded = u_string(existing, "sha256");
    if (size != expected || strcmp(hex, recorded) ||
        strcmp(checksum, recorded)) {
      status =
          u_error(error, 409, "PART_CONFLICT", "Chunk contains different data");
    } else {
      cJSON *reply = cJSON_Duplicate(existing, 1);
      cJSON_DeleteItemFromObjectCaseSensitive(reply, "reference");
      *result = u_json(reply);
      cJSON_Delete(reply);
    }
  }
  EVP_MD_CTX_free(hash);
  return status;
}
/* Stores a written chunk in the session under the session lock. The session is
 * read again: it may have been canceled or expired while the body streamed, and
 * other chunks may have been recorded meanwhile. */
static int record_part(upload_engine *engine, const char *id,
                       const cJSON *saved, void *context, upload_error *error) {
  void *lease = NULL;
  cJSON *session = NULL;
  int status = start(engine, id, "part", context, &lease, &session, error);
  if (status)
    return status;
  if (strcmp(u_string(session, "state"), "open")) {
    status = u_error(error, 409, "STATE", "Upload does not accept chunks");
    goto done;
  }
  int64_t index = u_number(saved, "index");
  cJSON *parts = cJSON_GetObjectItemCaseSensitive(session, "parts"), *item,
        *merged = cJSON_CreateArray();
  int placed = 0;
  cJSON_ArrayForEach(item, parts) {
    if (u_number(item, "index") == index) {
      cJSON_Delete(merged);
      goto done; /* recorded meanwhile */
    }
  }
  /* the chunk goes in at its place in index order */
  while ((item = cJSON_DetachItemFromArray(parts, 0))) {
    if (!placed && index < u_number(item, "index")) {
      cJSON_AddItemToArray(merged, cJSON_Duplicate(saved, 1));
      placed = 1;
    }
    cJSON_AddItemToArray(merged, item);
  }
  if (!placed)
    cJSON_AddItemToArray(merged, cJSON_Duplicate(saved, 1));
  replace(session, "parts", merged);
  /* progress keeps a long upload alive: the TTL counts inactivity */
  uint64_t renewed = now() + engine->options.ttl_milliseconds;
  if (renewed > (uint64_t)u_number(session, "expiresAt"))
    replace(session, "expiresAt", cJSON_CreateNumber((double)renewed));
  status = save(engine, session, error);
  if (!status && engine->options.notify) {
    char event[160];
    snprintf(event, sizeof(event), "%s:part-stored:%d", id, (int)index);
    char *json = u_json(session);
    engine->options.notify(event, "part-stored", json, context);
    free(json);
  }
done:
  cJSON_Delete(session);
  engine->options.sessions.unlock(engine->options.sessions.data, lease);
  return status;
}
/* The step of a part that runs under the chunk lock. */
static int store_part(upload_engine *engine, const char *id, int index,
                      const char *checksum, const struct part_plan *plan,
                      upload_read source, void *body, void *context,
                      char **result, upload_error *error) {
  /* another request may have stored this chunk number while this one waited */
  char *current = NULL;
  int status = engine->options.sessions.get(engine->options.sessions.data, id,
                                            &current, error);
  if (status)
    return status;
  cJSON *record = current ? cJSON_Parse(current) : NULL, *item;
  free(current);
  cJSON_ArrayForEach(item, cJSON_GetObjectItemCaseSensitive(record, "parts")) {
    if (u_number(item, "index") == index) {
      status = verify_part(item, checksum, plan->expected, source, body, result,
                           error);
      cJSON_Delete(record);
      return status;
    }
  }
  cJSON_Delete(record);
  char *session_json = u_json(plan->session), *part_json = u_json(plan->part),
       *receipt = NULL;
  struct checked_body checked = {source,   body,  0, plan->expected,
                                 EVP_MD_CTX_new(), checksum, error, 0, 0};
  if (!checked.hash || !session_json || !part_json) {
    EVP_MD_CTX_free(checked.hash);
    free(session_json);
    free(part_json);
    return u_error(error, 500, "MEMORY", "Allocation failed");
  }
  EVP_DigestInit_ex(checked.hash, EVP_sha256(), NULL);
  status = engine->options.storage.write_part(
      engine->options.storage.data, session_json, part_json, checked_read,
      &checked, context, &receipt, error);
  if (!status && (!checked.done || checked.failed))
    status = checked.failed
                 ? (error && error->status ? error->status : 400)
                 : u_error(error, 500, "STORAGE_BODY",
                           "Storage did not consume the complete body");
  EVP_MD_CTX_free(checked.hash);
  free(session_json);
  free(part_json);
  if (status) {
    free(receipt);
    return status;
  }
  cJSON *saved = cJSON_Parse(receipt);
  free(receipt);
  if (!cJSON_IsObject(saved) || u_number(saved, "index") != index ||
      u_number(saved, "size") != (int64_t)plan->expected ||
      strcmp(u_string(saved, "sha256"), checksum)) {
    cJSON_Delete(saved);
    return u_error(error, 500, "STORAGE_RECEIPT", "Invalid storage receipt");
  }
  status = record_part(engine, id, saved, context, error);
  if (!status) {
    cJSON_DeleteItemFromObjectCaseSensitive(saved, "reference");
    *result = u_json(saved);
  }
  cJSON_Delete(saved);
  return status;
}
/* Holds the session lock only to check and to record. The body streams outside
 * it, under a lock of its own per chunk number taken from the same store (key
 * "<id>-part-<index>"; session IDs are hex digests, so it is never another
 * session's ID), so chunks of one upload arrive side by side and a slow one
 * blocks nobody. */
int upload_part(upload_engine *engine, const char *id, int index,
                const char *checksum, upload_read source, void *body,
                void *context, char **result, upload_error *error) {
  *result = NULL;
  struct part_plan plan;
  int status =
      plan_part(engine, id, index, checksum, source, context, &plan, error);
  if (status)
    return status;
  if (plan.existing) {
    status = verify_part(plan.existing, checksum, plan.expected, source, body,
                         result, error);
  } else {
    char key[160];
    void *chunk = NULL;
    snprintf(key, sizeof(key), "%s-part-%d", id, index);
    status = engine->options.sessions.lock(engine->options.sessions.data, key,
                                           &chunk, error);
    if (!status) {
      status = store_part(engine, id, index, checksum, &plan, source, body,
                          context, result, error);
      engine->options.sessions.unlock(engine->options.sessions.data, chunk);
    }
  }
  cJSON_Delete(plan.session);
  cJSON_Delete(plan.part);
  cJSON_Delete(plan.existing);
  return status;
}
int upload_finish(upload_engine *engine, const char *id, void *context,
                  char **result, upload_error *error) {
  *result = NULL;
  void *lease = NULL;
  cJSON *session = NULL;
  int status = start(engine, id, "complete", context, &lease, &session, error);
  if (status)
    return status;
  status = reconcile(engine, session, context, error);
  if (status)
    goto done;
  if (!strcmp(u_string(session, "state"), "completed")) {
    *result = u_json(cJSON_GetObjectItemCaseSensitive(session, "result"));
    goto done;
  }
  if (!strcmp(u_string(session, "state"), "canceled")) {
    status = u_error(error, 409, "CANCELED", "Upload was canceled");
    goto done;
  }
  cJSON *parts = cJSON_GetObjectItemCaseSensitive(session, "parts"),
        *d = cJSON_GetObjectItemCaseSensitive(session, "descriptor");
  if (cJSON_GetArraySize(parts) != count(d)) {
    status = u_error(error, 409, "INCOMPLETE", "Upload is missing chunks");
    goto done;
  }
  for (int i = 0; i < cJSON_GetArraySize(parts); i++) {
    cJSON *part = cJSON_GetArrayItem(parts, i);
    int64_t chunk = u_number(d, "chunkSize"),
            remaining = u_number(d, "size") - (int64_t)i * chunk;
    if (u_number(part, "index") != i ||
        u_number(part, "size") != (remaining < chunk ? remaining : chunk)) {
      status = u_error(error, 409, "MANIFEST", "Invalid part manifest");
      goto done;
    }
  }
  replace(session, "state", cJSON_CreateString("finalizing"));
  status = save(engine, session, error);
  if (status)
    goto done;
  char *session_json = u_json(session), *manifest = u_json(parts),
       *completed = NULL;
  status =
      engine->options.storage.finish(engine->options.storage.data, session_json,
                                     manifest, context, &completed, error);
  if (status) {
    free(completed);
    completed = NULL;
    int check = engine->options.storage.inspect(
        engine->options.storage.data, session_json, context, &completed, error);
    if (!check && completed)
      status = 0;
  }
  free(session_json);
  free(manifest);
  if (status) {
    free(completed);
    goto done;
  }
  cJSON *value = cJSON_Parse(completed);
  free(completed);
  if (!value) {
    status = u_error(error, 500, "STORAGE_JSON", "Invalid completed result");
    goto done;
  }
  replace(session, "result", value);
  replace(session, "state", cJSON_CreateString("completed"));
  status = save(engine, session, error);
  if (!status) {
    notify(engine, "completed", session, context);
    *result = u_json(value);
  }
done:
  cJSON_Delete(session);
  engine->options.sessions.unlock(engine->options.sessions.data, lease);
  return status;
}
int upload_cancel(upload_engine *engine, const char *id, void *context,
                  char **result, upload_error *error) {
  *result = NULL;
  void *lease = NULL;
  cJSON *session = NULL;
  int status = start(engine, id, "cancel", context, &lease, &session, error);
  if (status)
    return status;
  status = reconcile(engine, session, context, error);
  if (status)
    goto done;
  if (!strcmp(u_string(session, "state"), "completed")) {
    status = u_error(error, 409, "COMPLETED",
                     "Remove completed files through the application");
    goto done;
  }
  char *raw = u_json(session);
  status = engine->options.storage.abort(engine->options.storage.data, raw,
                                         context, error);
  free(raw);
  if (!status) {
    replace(session, "state", cJSON_CreateString("canceled"));
    replace(session, "parts", cJSON_CreateArray());
    status = save(engine, session, error);
    notify(engine, "canceled", session, context);
    if (!status)
      *result = upload_copy("null");
  }
done:
  cJSON_Delete(session);
  engine->options.sessions.unlock(engine->options.sessions.data, lease);
  return status;
}
