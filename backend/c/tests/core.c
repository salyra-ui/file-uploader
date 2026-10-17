#define _POSIX_C_SOURCE 200809L
#include "salyra_upload.h"
#include <assert.h>
#include <cJSON.h>
#include <openssl/evp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
struct bytes {
  const char *text;
  size_t offset;
};
static long read_bytes(void *data, unsigned char *out, size_t capacity) {
  struct bytes *bytes = data;
  size_t n = strlen(bytes->text) - bytes->offset;
  if (n > capacity)
    n = capacity;
  memcpy(out, bytes->text + bytes->offset, n);
  bytes->offset += n;
  return (long)n;
}
static void checksum(const char *text, char out[65]) {
  unsigned char bytes[32];
  unsigned int length;
  EVP_Digest(text, strlen(text), bytes, &length, EVP_sha256(), NULL);
  for (int i = 0; i < 32; i++)
    sprintf(out + i * 2, "%02x", bytes[i]);
}
int main(void) {
  char directory[] = "/tmp/salyra-c-XXXXXX";
  assert(mkdtemp(directory));
  upload_disk *disk = upload_disk_new(directory);
  assert(disk);
  upload_options options = {0};
  options.sessions = upload_disk_sessions(disk);
  options.storage = upload_disk_storage(disk);
  options.allow_anonymous = 1;
  upload_engine *engine = upload_engine_new(&options);
  assert(engine);
  upload_error error = {0};
  char *result = NULL;
  assert(!upload_create(
      engine,
      "{\"protocol\":\"salyra-upload/1\",\"name\":\"test.txt\",\"type\":\"text/"
      "plain\",\"size\":8,\"lastModified\":0,\"chunkSize\":4}",
      "core", NULL, &result, &error));
  cJSON *created = cJSON_Parse(result);
  char *id =
      upload_copy(cJSON_GetObjectItemCaseSensitive(created, "id")->valuestring);
  cJSON_Delete(created);
  upload_free(result);
  assert(upload_finish(engine, id, NULL, &result, &error) == 409);
  char hash[65];
  checksum("efgh", hash);
  struct bytes body = {"efgh", 0};
  assert(!upload_part(engine, id, 1, hash, read_bytes, &body, NULL, &result,
                      &error));
  upload_free(result);
  checksum("xxxx", hash);
  body = (struct bytes){"abcd", 0};
  assert(upload_part(engine, id, 0, hash, read_bytes, &body, NULL, &result,
                     &error) == 422);
  checksum("abcd", hash);
  body = (struct bytes){"abcd", 0};
  assert(!upload_part(engine, id, 0, hash, read_bytes, &body, NULL, &result,
                      &error));
  upload_free(result);
  upload_engine_free(engine);
  engine = upload_engine_new(&options);
  assert(!upload_finish(engine, id, NULL, &result, &error));
  char *completed = upload_copy(result);
  upload_free(result);
  assert(!upload_finish(engine, id, NULL, &result, &error));
  assert(!strcmp(completed, result));
  upload_free(completed);
  upload_free(result);
  assert(upload_cancel(engine, id, NULL, &result, &error) == 409);
  upload_free(id);
  upload_engine_free(engine);
  upload_disk_free(disk);
  printf("C restart, checksum and completion tests passed\n");
  return 0;
}
