#ifndef SALYRA_UPLOAD_H
#define SALYRA_UPLOAD_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* All JSON returned through char** is allocated with upload_copy and freed by
 * the caller with upload_free. Input strings and request_context are borrowed
 * only for the duration of the operation. A read callback returns bytes, zero
 * at EOF, or -1 on failure. Never commit storage before successful EOF. */
typedef struct {
  int status;
  const char *code;
  const char *message;
} upload_error;
typedef long (*upload_read)(void *body, unsigned char *buffer, size_t capacity);
typedef struct {
  void *data;
  int (*lock)(void *, const char *, void **, upload_error *);
  void (*unlock)(void *, void *);
  int (*get)(void *, const char *, char **, upload_error *);
  int (*put)(void *, const char *, const char *, upload_error *);
} upload_session_store;
typedef struct {
  void *data;
  int (*begin)(void *, const char *, void *, char **, upload_error *);
  int (*write_part)(void *, const char *, const char *, upload_read, void *,
                    void *, char **, upload_error *);
  int (*probe)(void *, const char *, void *, char **, upload_error *);
  /* A null inspect result means the object does not exist. */
  int (*inspect)(void *, const char *, void *, char **, upload_error *);
  int (*finish)(void *, const char *, const char *, void *, char **,
                upload_error *);
  int (*abort)(void *, const char *, void *, upload_error *);
} upload_storage;
typedef struct {
  upload_session_store sessions;
  upload_storage storage;
  uint64_t ttl_milliseconds, max_file_size, max_chunk_size;
  const char *(*scope)(void *);
  int (*authorize)(const char *, const char *, void *, upload_error *);
  int (*validate)(const char *, void *, upload_error *);
  void (*notify)(const char *, const char *, const char *, void *);
  /* Without authorize anyone who reaches the routes can create, read and finish uploads:
     upload_engine_new returns NULL unless this is set (local demos, tests). */
  int allow_anonymous;
} upload_options;
typedef struct upload_engine upload_engine;
char *upload_copy(const char *text);
void upload_free(void *memory);
upload_engine *upload_engine_new(const upload_options *options);
void upload_engine_free(upload_engine *engine);
int upload_create(upload_engine *, const char *descriptor, const char *key,
                  void *context, char **result, upload_error *);
int upload_probe(upload_engine *, const char *id, void *context, char **result,
                 upload_error *);
int upload_part(upload_engine *, const char *id, int index, const char *sha256,
                upload_read, void *body, void *context, char **result,
                upload_error *);
int upload_finish(upload_engine *, const char *id, void *context, char **result,
                  upload_error *);
int upload_cancel(upload_engine *, const char *id, void *context, char **result,
                  upload_error *);
/* Local Unix filesystem adapters. Their directory is copied and remains valid
 * until upload_disk_free. */
typedef struct upload_disk upload_disk;
upload_disk *upload_disk_new(const char *directory);
void upload_disk_free(upload_disk *disk);
upload_session_store upload_disk_sessions(upload_disk *disk);
upload_storage upload_disk_storage(upload_disk *disk);
#ifdef __cplusplus
}
#endif
#endif
