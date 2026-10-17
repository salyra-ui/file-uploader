using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Salyra.Upload;

public sealed class UploadException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public record UploadContext(object? Application, CancellationToken Cancellation);

public interface ISessionStore
{
    Task<IAsyncDisposable> Lock(string id, CancellationToken token);
    Task<JsonObject?> Get(string id, CancellationToken token);
    Task Save(JsonObject session, CancellationToken token);
}

public interface IStorage
{
    Task<JsonNode?> Begin(JsonObject session, UploadContext context);
    Task<JsonObject> WritePart(
        JsonObject session,
        JsonObject part,
        Stream body,
        UploadContext context
    );
    Task<List<JsonObject>> Probe(JsonObject session, UploadContext context);
    Task<JsonNode?> InspectResult(JsonObject session, UploadContext context);
    Task<JsonNode?> Finish(JsonObject session, List<JsonObject> parts, UploadContext context);
    Task Abort(JsonObject session, UploadContext context);
}

public sealed class UploadOptions
{
    public long TtlMilliseconds { get; init; } = 86400000;
    public long MaxFileSize { get; init; } = 9007199254740991;
    public long MaxChunkSize { get; init; } = 64 * 1024 * 1024;
    public Func<UploadContext, string> Scope { get; init; } = _ => "";
    /// <summary>Without it, anyone who reaches the routes can create, read and finish uploads.</summary>
    public Func<string, JsonObject?, UploadContext, Task>? Authorize { get; init; }

    /// <summary>Allows an engine without Authorize (local demos, tests).</summary>
    public bool AllowAnonymous { get; init; }
    public Func<JsonObject, UploadContext, Task> Validate { get; init; } =
        (_, _) => Task.CompletedTask;
    public Func<
        string,
        string,
        JsonObject,
        JsonObject?,
        UploadContext,
        Task
    > Notify { get; init; } = (_, _, _, _, _) => Task.CompletedTask;
    public Action<Exception> OnNotificationError { get; init; } = _ => { };
}

public sealed class UploadEngine(
    ISessionStore sessions,
    IStorage storage,
    UploadOptions? configuration = null
)
{
    public ISessionStore Sessions { get; } = sessions;
    public IStorage Storage { get; } = storage;
    public UploadOptions Options { get; } = Checked(configuration ?? new());

    static UploadOptions Checked(UploadOptions options) =>
        options.Authorize is null && !options.AllowAnonymous
            ? throw new ArgumentException(
                "Provide Authorize (and Scope) from your authentication, or AllowAnonymous for a local demo"
            )
            : options;

    Task Authorized(string operation, JsonObject? session, UploadContext context) =>
        Options.Authorize?.Invoke(operation, session, context) ?? Task.CompletedTask;

    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    static long Number(JsonNode node, string field)
    {
        var value = (JsonValue)node[field]!;
        if (value.TryGetValue<long>(out long wide))
            return wide;
        if (value.TryGetValue<int>(out int narrow))
            return narrow;
        throw new InvalidOperationException("Expected an integer");
    }

    static string Text(JsonNode node, string field) => node[field]!.GetValue<string>();

    static int Count(JsonNode descriptor) =>
        (int)
            Math.Max(
                1,
                (Number(descriptor, "size") + Number(descriptor, "chunkSize") - 1)
                    / Number(descriptor, "chunkSize")
            );

    static UploadException Fail(int status, string code, string message) =>
        new(status, code, message);

    async Task Notify(string type, JsonObject session, JsonObject? part, UploadContext context)
    {
        try
        {
            await Options.Notify(
                Text(session, "id")
                    + ":"
                    + type
                    + (part is null ? "" : ":" + Number(part, "index")),
                type,
                session,
                part,
                context
            );
        }
        catch (Exception error)
        {
            Options.OnNotificationError(error);
        }
    }

    public async Task<JsonObject> CreateUpload(
        JsonObject descriptor,
        string key,
        UploadContext context
    )
    {
        await Authorized("create", null, context);
        bool valid;
        try
        {
            valid =
                Text(descriptor, "protocol") == "salyra-upload/1"
                && Text(descriptor, "name").EnumerateRunes().Count() <= 1024
                && descriptor["type"] is JsonValue
                && Number(descriptor, "size") >= 0
                && Number(descriptor, "size") <= 9007199254740991
                && Number(descriptor, "lastModified") >= 0
                && Number(descriptor, "lastModified") <= 9007199254740991
                && Number(descriptor, "chunkSize") >= 1
                && Number(descriptor, "chunkSize") <= Options.MaxChunkSize
                && key.Length is > 0 and <= 200;
        }
        catch
        {
            valid = false;
        }
        if (!valid)
            throw Fail(400, "DESCRIPTOR", "Invalid upload configuration");
        if (
            Number(descriptor, "size") > Options.MaxFileSize
            || Math.Ceiling((double)Number(descriptor, "size") / Number(descriptor, "chunkSize"))
                > 100000
        )
            throw Fail(413, "FILE_SIZE", "File exceeds its limit");
        await Options.Validate(descriptor, context);
        string id = Convert
            .ToHexString(
                SHA256.HashData(
                    Encoding.UTF8.GetBytes(
                        new JsonArray(Options.Scope(context), key).ToJsonString()
                    )
                )
            )
            .ToLowerInvariant();
        await using var lease = await Sessions.Lock(id, context.Cancellation);
        var existing = await Sessions.Get(id, context.Cancellation);
        if (existing is not null)
        {
            await Authorized("create", existing, context);
            if (!JsonNode.DeepEquals(existing["descriptor"], descriptor))
                throw Fail(409, "KEY_CONFLICT", "Key belongs to another file");
            if (Number(existing, "expiresAt") <= Now() && Text(existing, "state") == "finalizing")
                await Reconcile(existing, context);
            if (Number(existing, "expiresAt") <= Now() && Text(existing, "state") != "completed")
                throw Fail(410, "EXPIRED", "Session expired");
            return new()
            {
                ["id"] = id,
                ["chunkSize"] = Number(descriptor, "chunkSize"),
                ["expiresAt"] = Number(existing, "expiresAt"),
            };
        }
        var session = new JsonObject
        {
            ["id"] = id,
            ["descriptor"] = descriptor.DeepClone(),
            ["expiresAt"] = Now() + Options.TtlMilliseconds,
            ["state"] = "open",
            ["parts"] = new JsonArray(),
        };
        session["storageRef"] = await Storage.Begin(session, context);
        await Sessions.Save(session, context.Cancellation);
        await Notify("created", session, null, context);
        return new()
        {
            ["id"] = id,
            ["chunkSize"] = Number(descriptor, "chunkSize"),
            ["expiresAt"] = Number(session, "expiresAt"),
        };
    }

    async Task<JsonObject> Get(string id, string operation, UploadContext context)
    {
        var session =
            await Sessions.Get(id, context.Cancellation)
            ?? throw Fail(404, "NOT_FOUND", "Upload session was not found");
        await Authorized(operation, session, context);
        string state = Text(session, "state");
        if (state == "expired")
            throw Fail(410, "EXPIRED", "Session expired");
        if (Number(session, "expiresAt") <= Now() && state is not ("completed" or "canceled"))
        {
            if (state == "finalizing")
            {
                await Reconcile(session, context);
                if (Text(session, "state") == "completed") return session;
            }
            await Storage.Abort(session, context);
            session["state"] = "expired";
            await Sessions.Save(session, context.Cancellation);
            await Notify("expired", session, null, context);
            throw Fail(410, "EXPIRED", "Session expired");
        }
        return session;
    }

    async Task Reconcile(JsonObject session, UploadContext context)
    {
        if (Text(session, "state") is "completed" or "canceled")
            return;
        var result = await Storage.InspectResult(session, context);
        if (result is not null)
        {
            session["state"] = "completed";
            session["result"] = result;
        }
        else
        {
            var parts = (await Storage.Probe(session, context))
                .OrderBy(p => Number(p, "index"))
                .ToList();
            var seen = new HashSet<long>();
            var descriptor = session["descriptor"]!;
            long size = Number(descriptor, "size"),
                chunk = Number(descriptor, "chunkSize");
            foreach (var part in parts)
            {
                long index = Number(part, "index");
                if (
                    index < 0
                    || index >= Count(descriptor)
                    || !seen.Add(index)
                    || Number(part, "size") != Math.Min(chunk, size - index * chunk)
                )
                    throw Fail(500, "STORAGE_CHECKPOINT", "Storage returned an invalid part");
            }
            session["parts"] = new JsonArray(parts.Select(p => (JsonNode)p).ToArray());
        }
        await Sessions.Save(session, context.Cancellation);
    }

    public async Task<JsonObject> GetUpload(string id, UploadContext context)
    {
        await using var lease = await Sessions.Lock(id, context.Cancellation);
        var session = await Get(id, "probe", context);
        await Reconcile(session, context);
        var parts = new JsonArray();
        foreach (var part in session["parts"]!.AsArray())
        {
            var copy = part!.DeepClone().AsObject();
            copy.Remove("reference");
            parts.Add(copy);
        }
        var result = new JsonObject
        {
            ["status"] = Text(session, "state"),
            ["expiresAt"] = Number(session, "expiresAt"),
            ["parts"] = parts,
        };
        if (Text(session, "state") == "completed")
            result["result"] = session["result"]?.DeepClone();
        return result;
    }

    public async Task<JsonObject> ReceivePart(
        string id,
        int index,
        string checksum,
        Stream body,
        UploadContext context
    )
    {
        await using var lease = await Sessions.Lock(id, context.Cancellation);
        var session = await Get(id, "part", context);
        if (Text(session, "state") != "open")
            throw Fail(409, "STATE", "Upload does not accept chunks");
        var descriptor = session["descriptor"]!;
        if (
            index < 0
            || index >= Count(descriptor)
            || !System.Text.RegularExpressions.Regex.IsMatch(checksum, "\\A[a-f0-9]{64}\\z")
        )
            throw Fail(400, "PART", "Invalid chunk or checksum");
        long chunk = Number(descriptor, "chunkSize");
        var part = new JsonObject
        {
            ["index"] = index,
            ["size"] = Math.Min(chunk, Number(descriptor, "size") - index * chunk),
            ["sha256"] = checksum,
        };
        var saved = await Storage.WritePart(session, part, body, context);
        var parts = session["parts"]!
            .AsArray()
            .Where(p => Number(p!, "index") != index)
            .Select(p => p!.DeepClone().AsObject())
            .Append(saved)
            .OrderBy(p => Number(p, "index"))
            .ToList();
        session["parts"] = new JsonArray(parts.Select(p => (JsonNode)p).ToArray());
        await Sessions.Save(session, context.Cancellation);
        await Notify("part-stored", session, saved, context);
        var receipt = saved.DeepClone().AsObject();
        receipt.Remove("reference");
        return receipt;
    }

    public async Task<JsonNode?> FinishUpload(string id, UploadContext context)
    {
        await using var lease = await Sessions.Lock(id, context.Cancellation);
        var session = await Get(id, "complete", context);
        await Reconcile(session, context);
        if (Text(session, "state") == "completed")
            return session["result"]?.DeepClone();
        if (Text(session, "state") == "canceled")
            throw Fail(409, "CANCELED", "Upload was canceled");
        var parts = session["parts"]!.AsArray().Select(p => p!.DeepClone().AsObject()).ToList();
        if (
            parts.Count != Count(session["descriptor"]!)
            || parts.Where((part, index) => Number(part, "index") != index).Any()
        )
            throw Fail(409, "INCOMPLETE", "Upload is missing chunks");
        session["state"] = "finalizing";
        await Sessions.Save(session, context.Cancellation);
        JsonNode? result;
        try
        {
            result = await Storage.Finish(session, parts, context);
        }
        catch
        {
            result = await Storage.InspectResult(session, context);
            if (result is null)
                throw;
        }
        session["state"] = "completed";
        session["result"] = result?.DeepClone();
        await Sessions.Save(session, context.Cancellation);
        await Notify("completed", session, null, context);
        return result;
    }

    public async Task CancelUpload(string id, UploadContext context)
    {
        await using var lease = await Sessions.Lock(id, context.Cancellation);
        var session = await Get(id, "cancel", context);
        await Reconcile(session, context);
        if (Text(session, "state") == "completed")
            throw Fail(409, "COMPLETED", "Remove completed files through the application");
        await Storage.Abort(session, context);
        session["state"] = "canceled";
        session["parts"] = new JsonArray();
        await Sessions.Save(session, context.Cancellation);
        await Notify("canceled", session, null, context);
    }
}
