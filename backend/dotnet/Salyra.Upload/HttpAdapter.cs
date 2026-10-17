using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;

namespace Salyra.Upload;

public record UploadRoute(string Operation, string Id = "", int Index = 0);

public static class UploadHttp
{
    public static async Task Handle(UploadEngine engine, HttpContext http, UploadRoute route)
    {
        try
        {
            var context = new UploadContext(http, http.RequestAborted);
            JsonNode? result = null;
            switch (route.Operation)
            {
                case "create":
                    // a cross-site form can post text/plain without a CORS preflight, not this type
                    if (
                        !string.Equals(
                            http.Request.ContentType?.Split(';')[0].Trim(),
                            "application/json",
                            StringComparison.OrdinalIgnoreCase
                        )
                    )
                        throw new UploadException(
                            415,
                            "CONTENT_TYPE",
                            "Upload metadata must be sent as application/json"
                        );
                    using (var memory = new MemoryStream())
                    {
                        byte[] buffer = new byte[8192];
                        int count;
                        while (
                            (count = await http.Request.Body.ReadAsync(buffer, http.RequestAborted))
                            > 0
                        )
                        {
                            if (memory.Length + count > 65536)
                                throw new UploadException(
                                    413,
                                    "JSON_SIZE",
                                    "Upload metadata is too large"
                                );
                            memory.Write(buffer, 0, count);
                        }
                        JsonObject descriptor;
                        try
                        {
                            descriptor = JsonNode.Parse(memory.ToArray())!.AsObject();
                        }
                        catch
                        {
                            throw new UploadException(400, "JSON", "Invalid JSON body");
                        }
                        result = await engine.CreateUpload(
                            descriptor,
                            http.Request.Headers["Idempotency-Key"].ToString(),
                            context
                        );
                    }
                    break;
                case "probe":
                    result = await engine.GetUpload(route.Id, context);
                    break;
                case "part":
                    result = await engine.ReceivePart(
                        route.Id,
                        route.Index,
                        http.Request.Headers["Upload-Checksum"].ToString(),
                        http.Request.Body,
                        context
                    );
                    break;
                case "complete":
                    result = await engine.FinishUpload(route.Id, context);
                    break;
                case "cancel":
                    await engine.CancelUpload(route.Id, context);
                    break;
                default:
                    throw new UploadException(404, "NOT_FOUND", "Route was not found");
            }
            http.Response.Headers.CacheControl = "no-store";
            await http.Response.WriteAsJsonAsync(result, http.RequestAborted);
        }
        catch (UploadException error)
        {
            http.Response.StatusCode = error.Status;
            await http.Response.WriteAsJsonAsync(
                new { code = error.Code, message = error.Message },
                http.RequestAborted
            );
        }
        catch (Exception) when (!http.RequestAborted.IsCancellationRequested)
        {
            http.Response.StatusCode = 500;
            await http.Response.WriteAsJsonAsync(
                new { code = "INTERNAL", message = "Upload operation failed" },
                http.RequestAborted
            );
        }
    }
}
