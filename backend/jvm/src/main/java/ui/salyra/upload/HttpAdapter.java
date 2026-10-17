package ui.salyra.upload;

import static ui.salyra.upload.UploadEngine.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.concurrent.*;

public final class HttpAdapter implements HttpHandler {
  public record Route(String operation, String id, int index) {}

  @FunctionalInterface
  public interface Matcher {
    Route match(HttpExchange exchange);
  }

  @FunctionalInterface
  public interface ContextFactory {
    Context create(HttpExchange exchange);
  }

  final UploadEngine engine;
  final Matcher match;
  final ContextFactory context;

  public HttpAdapter(UploadEngine engine, Matcher match, ContextFactory context) {
    this.engine = engine;
    this.match = match;
    this.context = context;
  }

  public HttpAdapter(UploadEngine engine, String base) {
    this(
        engine,
        exchange -> {
          String path = exchange.getRequestURI().getPath(), method = exchange.getRequestMethod();
          if (path.equals(base) && method.equals("POST")) return new Route("create", "", 0);
          if (!path.startsWith(base + "/")) return null;
          String[] parts = path.substring(base.length() + 1).split("/");
          if (parts.length == 1 && method.equals("GET")) return new Route("probe", parts[0], 0);
          if (parts.length == 1 && method.equals("DELETE")) return new Route("cancel", parts[0], 0);
          if (parts.length == 2 && parts[1].equals("complete") && method.equals("POST"))
            return new Route("complete", parts[0], 0);
          if (parts.length == 3
              && parts[1].equals("parts")
              && parts[2].matches("\\d+")
              && method.equals("PUT")) {
            try {
              return new Route("part", parts[0], Integer.parseInt(parts[2]));
            } catch (NumberFormatException error) {
              return null;
            }
          }
          return null;
        },
        exchange -> new Context(exchange, new java.util.concurrent.atomic.AtomicBoolean()));
  }

  public void handle(HttpExchange exchange) throws IOException {
    int status = 200;
    JsonNode result;
    try {
      Route route = match.match(exchange);
      if (route == null) throw fail(404, "NOT_FOUND", "Route was not found");
      Context context = this.context.create(exchange);
      result =
          switch (route.operation) {
            case "create" -> {
              // a cross-site form can post text/plain without a CORS preflight, not this type
              String type = exchange.getRequestHeaders().getFirst("Content-Type");
              if (type == null
                  || !type.split(";")[0].trim().equalsIgnoreCase("application/json"))
                throw fail(415, "CONTENT_TYPE", "Upload metadata must be sent as application/json");
              byte[] body = exchange.getRequestBody().readNBytes(65537);
              if (body.length > 65536) throw fail(413, "JSON_SIZE", "Upload metadata is too large");
              JsonNode value = JSON.readTree(body);
              if (!(value instanceof ObjectNode)) throw fail(400, "JSON", "Invalid JSON body");
              yield engine.createUpload(
                  (ObjectNode) value,
                  exchange.getRequestHeaders().getFirst("Idempotency-Key") == null
                      ? ""
                      : exchange.getRequestHeaders().getFirst("Idempotency-Key"),
                  context);
            }
            case "probe" -> engine.getUpload(route.id, context);
            case "part" ->
                engine.receivePart(
                    route.id,
                    route.index,
                    exchange.getRequestHeaders().getFirst("Upload-Checksum") == null
                        ? ""
                        : exchange.getRequestHeaders().getFirst("Upload-Checksum"),
                    exchange.getRequestBody(),
                    context);
            case "complete" -> engine.finishUpload(route.id, context);
            case "cancel" -> {
              engine.cancelUpload(route.id, context);
              yield JSON.nullNode();
            }
            default -> throw fail(404, "NOT_FOUND", "Route was not found");
          };
    } catch (UploadException error) {
      status = error.status;
      result = JSON.createObjectNode().put("code", error.code).put("message", error.getMessage());
    } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
      status = 400;
      result = JSON.createObjectNode().put("code", "JSON").put("message", "Invalid JSON body");
    } catch (Exception error) {
      status = 500;
      result =
          JSON.createObjectNode().put("code", "INTERNAL").put("message", "Upload operation failed");
    }
    byte[] data = JSON.writeValueAsBytes(result);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.getResponseHeaders().set("Cache-Control", "no-store");
    exchange.sendResponseHeaders(status, data.length);
    try (OutputStream output = exchange.getResponseBody()) {
      output.write(data);
    }
  }

  public static void main(String[] arguments) throws Exception {
    Path directory = Path.of(System.getenv().getOrDefault("UPLOAD_DIRECTORY", ".uploads"));
    String host = System.getenv().getOrDefault("HOST", "127.0.0.1");
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "4338"));
    UploadEngine.Options options = new UploadEngine.Options();
    options.allowAnonymous = true; // a local demo: set authorize in an application
    UploadEngine engine =
        new UploadEngine(
            new Filesystem.Sessions(directory.resolve("sessions")),
            new Filesystem.Content(directory.resolve("storage")),
            options);
    HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
    server.createContext("/uploads", new HttpAdapter(engine, "/uploads"));
    server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    server.start();
  }
}
