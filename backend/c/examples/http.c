#define _POSIX_C_SOURCE 200809L
/* A localhost example, not an HTTP framework. Applications call upload_* from
 * their own routes. Each connection has a thread (at most MAX_CLIENTS at once),
 * so the chunks of one upload are received side by side. */
#include "salyra_upload.h"
#include <arpa/inet.h>
#include <cJSON.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
struct socket_body {
  int socket;
  size_t remaining;
};
static long socket_read(void *data, unsigned char *buffer, size_t capacity) {
  struct socket_body *body = data;
  if (!body->remaining)
    return 0;
  if (capacity > body->remaining)
    capacity = body->remaining;
  ssize_t count;
  do {
    count = recv(body->socket, buffer, capacity, 0);
  } while (count < 0 && errno == EINTR);
  if (count <= 0)
    return -1;
  body->remaining -= (size_t)count;
  return count;
}
static const char *header(char *headers, const char *name) {
  size_t length = strlen(name);
  char *line = headers;
  while (line && *line) {
    if (!strncasecmp(line, name, length) && line[length] == ':') {
      line += length + 1;
      while (*line == ' ' || *line == '\t')
        line++;
      return line;
    }
    line = strchr(line, '\n');
    if (line)
      line++;
  }
  return NULL;
}
static void send_all(int socket, const char *bytes, size_t size) {
  while (size) {
    ssize_t n = send(socket, bytes, size, MSG_NOSIGNAL);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      return;
    bytes += n;
    size -= (size_t)n;
  }
}
static void respond(int socket, int status, const char *json) {
  char headers[512];
  size_t size = strlen(json);
  int length = snprintf(
      headers, sizeof(headers),
      "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: "
      "%zu\r\nConnection: close\r\n\r\n",
      status, status < 400 ? "OK" : "Error", size);
  send_all(socket, headers, (size_t)length);
  send_all(socket, json, size);
}
static void request(upload_engine *engine, int socket) {
  char headers[16385];
  size_t length = 0;
  while (length < sizeof(headers) - 1) {
    ssize_t n = recv(socket, headers + length, 1, 0);
    if (n <= 0)
      return;
    length++;
    if (length >= 4 && !memcmp(headers + length - 4, "\r\n\r\n", 4))
      break;
  }
  headers[length] = 0;
  char method[16], url[512];
  if (sscanf(headers, "%15s %511s", method, url) != 2) {
    respond(socket, 400, "{}");
    return;
  }
  size_t body_length = 0;
  const char *size_header = header(headers, "Content-Length");
  if (size_header) {
    char *end;
    unsigned long long value = strtoull(size_header, &end, 10);
    if (end == size_header || (*end != '\r' && *end != '\n') ||
        value > 64 * 1024 * 1024) {
      respond(socket, 400, "{}");
      return;
    }
    body_length = (size_t)value;
  }
  if (header(headers, "Transfer-Encoding")) {
    respond(socket, 400,
            "{\"code\":\"CONTENT_LENGTH\",\"message\":\"This example requires "
            "Content-Length\"}");
    return;
  }
  struct socket_body body = {socket, body_length};
  upload_error error = {0};
  char *result = NULL;
  int status = 404;
  char id[101], operation[64];
  int matched = sscanf(url, "/uploads/%100[^/]/%63s", id, operation);
  if (!strcmp(method, "POST") && !strcmp(url, "/uploads")) {
    /* a cross-site form can post text/plain without a CORS preflight, not this type */
    const char *type = header(headers, "Content-Type");
    if (!type || strncasecmp(type, "application/json", 16) ||
        (type[16] && type[16] != ';' && type[16] != ' ' && type[16] != '\r')) {
      respond(socket, 415,
              "{\"code\":\"CONTENT_TYPE\",\"message\":\"Upload metadata must be "
              "sent as application/json\"}");
      return;
    }
    if (body_length > 65536) {
      respond(socket, 413, "{}");
      return;
    }
    char json[65537];
    size_t read = 0;
    while (read < body_length) {
      long n =
          socket_read(&body, (unsigned char *)json + read, body_length - read);
      if (n < 0)
        return;
      read += (size_t)n;
    }
    json[read] = 0;
    char key[201] = {0};
    const char *raw = header(headers, "Idempotency-Key");
    if (raw) {
      size_t n = strcspn(raw, "\r\n");
      if (n < sizeof(key))
        memcpy(key, raw, n);
    }
    status = upload_create(engine, json, key, NULL, &result, &error);
  } else if (matched == 1 && !strcmp(method, "GET"))
    status = upload_probe(engine, id, NULL, &result, &error);
  else if (matched == 1 && !strcmp(method, "DELETE"))
    status = upload_cancel(engine, id, NULL, &result, &error);
  else if (matched == 2 && !strcmp(operation, "complete") &&
           !strcmp(method, "POST"))
    status = upload_finish(engine, id, NULL, &result, &error);
  else if (matched == 2 && !strncmp(operation, "parts/", 6) &&
           !strcmp(method, "PUT")) {
    char *end;
    long index = strtol(operation + 6, &end, 10);
    char checksum[65] = {0};
    const char *raw = header(headers, "Upload-Checksum");
    if (raw && strcspn(raw, "\r\n") == 64)
      memcpy(checksum, raw, 64);
    if (!*end && index >= 0 && index <= 100000)
      status = upload_part(engine, id, (int)index, checksum, socket_read, &body,
                           NULL, &result, &error);
    else
      status = 400;
  }
  unsigned char discarded[65536];
  while (body.remaining) {
    if (socket_read(&body, discarded, sizeof(discarded)) < 0)
      break;
  }
  if (status) {
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "code", error.code ? error.code : "ROUTE");
    cJSON_AddStringToObject(json, "message",
                            error.message ? error.message
                                          : "Request was rejected");
    char *text = cJSON_PrintUnformatted(json);
    respond(socket, status, text);
    free(text);
    cJSON_Delete(json);
  } else
    respond(socket, 200, result ? result : "null");
  upload_free(result);
}
#define MAX_CLIENTS 32
static pthread_mutex_t clients_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t client_left = PTHREAD_COND_INITIALIZER;
static int clients;
struct client {
  upload_engine *engine;
  int socket;
};
static void *serve(void *data) {
  struct client *client = data;
  struct timeval timeout = {30, 0};
  setsockopt(client->socket, SOL_SOCKET, SO_RCVTIMEO, &timeout,
             sizeof(timeout));
  setsockopt(client->socket, SOL_SOCKET, SO_SNDTIMEO, &timeout,
             sizeof(timeout));
  request(client->engine, client->socket);
  close(client->socket);
  free(client);
  pthread_mutex_lock(&clients_lock);
  clients--;
  pthread_cond_signal(&client_left);
  pthread_mutex_unlock(&clients_lock);
  return NULL;
}
int main(void) {
  const char *root = getenv("UPLOAD_DIRECTORY");
  upload_disk *disk = upload_disk_new(root ? root : "/tmp/salyra-c-uploads");
  if (!disk)
    return 1;
  upload_options options = {0};
  options.sessions = upload_disk_sessions(disk);
  options.storage = upload_disk_storage(disk);
  options.allow_anonymous = 1; /* a local demo: set authorize in an application */
  upload_engine *engine = upload_engine_new(&options);
  if (!engine)
    return 1;
  int server = socket(AF_INET, SOCK_STREAM, 0);
  int yes = 1;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port =
      htons((uint16_t)(getenv("PORT") ? atoi(getenv("PORT")) : 4343));
  const char *host = getenv("HOST");
  inet_pton(AF_INET, host ? host : "127.0.0.1", &address.sin_addr);
  if (bind(server, (struct sockaddr *)&address, sizeof(address)) ||
      listen(server, 64))
    return 1;
  for (;;) {
    int client = accept(server, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    struct client *connection = malloc(sizeof(*connection));
    pthread_t thread;
    pthread_mutex_lock(&clients_lock);
    while (clients >= MAX_CLIENTS)
      pthread_cond_wait(&client_left, &clients_lock);
    clients++;
    pthread_mutex_unlock(&clients_lock);
    if (connection) {
      connection->engine = engine;
      connection->socket = client;
    }
    if (!connection || pthread_create(&thread, NULL, serve, connection)) {
      close(client);
      free(connection);
      pthread_mutex_lock(&clients_lock);
      clients--;
      pthread_mutex_unlock(&clients_lock);
      continue;
    }
    pthread_detach(thread);
  }
  close(server);
  upload_engine_free(engine);
  upload_disk_free(disk);
  return 0;
}
