#define _POSIX_C_SOURCE 200809L
/* Chunks of one upload arrive side by side. A chunk body here is a pipe, so a
 * chunk can stall inside the engine until its writer sends the rest. A hung
 * engine ends the test through the alarm. */
#include "salyra_upload.h"
#include <assert.h>
#include <cJSON.h>
#include <dirent.h>
#include <openssl/evp.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static upload_engine *engine;
static upload_session_store sessions;
static char directory[] = "/tmp/salyra-c-parallel-XXXXXX";
static void pause_ms(long ms) {
  struct timespec wait = {ms / 1000, (ms % 1000) * 1000000L};
  nanosleep(&wait, NULL);
}
static void checksum(const char *text, char out[65]) {
  unsigned char bytes[32];
  unsigned int length;
  EVP_Digest(text, strlen(text), bytes, &length, EVP_sha256(), NULL);
  for (int i = 0; i < 32; i++)
    sprintf(out + i * 2, "%02x", bytes[i]);
}
static long read_pipe(void *data, unsigned char *out, size_t capacity) {
  ssize_t n = read(*(int *)data, out, capacity);
  return n < 0 ? -1 : (long)n;
}
struct chunk {
  char id[65];
  int index, pipe_read, pipe_write, status, done;
  char text[16];
  pthread_t thread;
};
static void *run_chunk(void *data) {
  struct chunk *chunk = data;
  char hash[65], *result = NULL;
  upload_error error = {0};
  checksum(chunk->text, hash);
  chunk->status = upload_part(engine, chunk->id, chunk->index, hash, read_pipe,
                              &chunk->pipe_read, NULL, &result, &error);
  upload_free(result);
  __atomic_store_n(&chunk->done, 1, __ATOMIC_SEQ_CST);
  return NULL;
}
/* Starts a chunk. With a whole body it can finish at once; otherwise only its
 * first byte is sent and the rest comes from release(). */
static void start_chunk(struct chunk *chunk, const char *id, int index,
                        const char *text, int whole) {
  int fds[2];
  assert(!pipe(fds));
  memset(chunk, 0, sizeof(*chunk));
  strcpy(chunk->id, id);
  chunk->index = index;
  chunk->pipe_read = fds[0];
  chunk->pipe_write = fds[1];
  strcpy(chunk->text, text);
  assert(!pthread_create(&chunk->thread, NULL, run_chunk, chunk));
  if (whole) {
    assert(write(fds[1], text, strlen(text)) == (ssize_t)strlen(text));
    close(fds[1]);
    chunk->pipe_write = -1;
  } else {
    assert(write(fds[1], text, 1) == 1);
    pause_ms(300);
  }
}
static void release(struct chunk *chunk) {
  assert(write(chunk->pipe_write, chunk->text + 1, strlen(chunk->text) - 1) ==
         (ssize_t)strlen(chunk->text) - 1);
  close(chunk->pipe_write);
  chunk->pipe_write = -1;
}
static int finish_chunk(struct chunk *chunk) {
  pthread_join(chunk->thread, NULL);
  close(chunk->pipe_read);
  return chunk->status;
}
static void create(int chunks, char id[65]) {
  char descriptor[256], key[32], *result = NULL;
  static int counter;
  upload_error error = {0};
  snprintf(
      descriptor, sizeof(descriptor),
      "{\"protocol\":\"salyra-upload/1\",\"name\":\"t.txt\",\"type\":\"text/"
      "plain\",\"size\":%d,\"lastModified\":0,\"chunkSize\":4}",
      chunks * 4);
  snprintf(key, sizeof(key), "parallel-%d", counter++);
  assert(!upload_create(engine, descriptor, key, NULL, &result, &error));
  cJSON *created = cJSON_Parse(result);
  strcpy(id, cJSON_GetObjectItemCaseSensitive(created, "id")->valuestring);
  cJSON_Delete(created);
  upload_free(result);
}
static cJSON *record(const char *id) {
  char *json = NULL;
  upload_error error = {0};
  assert(!sessions.get(sessions.data, id, &json, &error) && json);
  cJSON *session = cJSON_Parse(json);
  free(json);
  return session;
}
static int locks_left(const char *id) {
  char path[256];
  snprintf(path, sizeof(path), "%s/locks", directory);
  DIR *dir = opendir(path);
  int found = 0;
  struct dirent *entry;
  while (dir && (entry = readdir(dir)))
    if (!strncmp(entry->d_name, id, strlen(id)) &&
        strstr(entry->d_name, "-part-"))
      found++;
  if (dir)
    closedir(dir);
  return found;
}
int main(void) {
  alarm(120);
  assert(mkdtemp(directory));
  upload_disk *disk = upload_disk_new(directory);
  assert(disk);
  upload_options options = {0};
  options.sessions = sessions = upload_disk_sessions(disk);
  options.storage = upload_disk_storage(disk);
  options.allow_anonymous = 1;
  engine = upload_engine_new(&options);
  assert(engine);
  char id[65], *result = NULL;
  upload_error error = {0};
  struct chunk slow, other, twin;
  /* a chunk that is still streaming blocks no other chunk of the same upload */
  create(2, id);
  start_chunk(&slow, id, 0, "abcd", 0);
  start_chunk(&other, id, 1, "efgh", 1);
  assert(!finish_chunk(&other));
  assert(!__atomic_load_n(&slow.done, __ATOMIC_SEQ_CST));
  release(&slow);
  assert(!finish_chunk(&slow));
  assert(!upload_finish(engine, id, NULL, &result, &error));
  upload_free(result);
  /* one writer per chunk number: the same chunk sent twice at once is stored
   * once */
  create(1, id);
  start_chunk(&slow, id, 0, "abcd", 0);
  start_chunk(&twin, id, 0, "abcd", 1);
  pause_ms(300);
  assert(!__atomic_load_n(&twin.done, __ATOMIC_SEQ_CST));
  release(&slow);
  assert(!finish_chunk(&slow) && !finish_chunk(&twin));
  cJSON *saved = record(id);
  assert(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(saved, "parts")) ==
         1);
  cJSON_Delete(saved);
  /* a session canceled while a chunk streams does not take the chunk */
  create(1, id);
  start_chunk(&slow, id, 0, "abcd", 0);
  assert(!upload_cancel(engine, id, NULL, &result, &error));
  upload_free(result);
  release(&slow);
  assert(finish_chunk(&slow) != 0);
  saved = record(id);
  assert(!strcmp(cJSON_GetObjectItemCaseSensitive(saved, "state")->valuestring,
                 "canceled"));
  assert(!cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(saved, "parts")));
  cJSON_Delete(saved);
  /* many chunks at once: none is lost from the session record, the TTL follows
   * progress and the chunk locks of the finished upload are gone */
  enum { burst = 24 };
  static struct chunk chunks[burst];
  create(burst, id);
  saved = record(id);
  double expires =
      cJSON_GetObjectItemCaseSensitive(saved, "expiresAt")->valuedouble;
  cJSON_Delete(saved);
  pause_ms(5);
  for (int i = 0; i < burst; i++) {
    char text[16];
    snprintf(text, sizeof(text), "%04d", i);
    start_chunk(&chunks[i], id, i, text, 1);
  }
  for (int i = 0; i < burst; i++)
    assert(!finish_chunk(&chunks[i]));
  saved = record(id);
  cJSON *parts = cJSON_GetObjectItemCaseSensitive(saved, "parts");
  assert(cJSON_GetArraySize(parts) == burst);
  for (int i = 0; i < burst; i++)
    assert((int)cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(parts, i),
                                                 "index")
               ->valuedouble == i);
  assert(cJSON_GetObjectItemCaseSensitive(saved, "expiresAt")->valuedouble >
         expires);
  cJSON_Delete(saved);
  assert(!upload_finish(engine, id, NULL, &result, &error));
  upload_free(result);
  assert(!locks_left(id));
  upload_engine_free(engine);
  upload_disk_free(disk);
  printf("C parallel chunk tests passed\n");
  return 0;
}
