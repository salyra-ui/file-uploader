using Salyra.Upload;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
string directory = Environment.GetEnvironmentVariable("UPLOAD_DIRECTORY") ?? ".uploads";
var engine = new UploadEngine(
    new DiskSessions(Path.Combine(directory, "sessions")),
    new DiskStorage(Path.Combine(directory, "storage")),
    new UploadOptions { AllowAnonymous = true } // a local demo: pass Authorize in an application
);

// Register these operations on any paths your application chooses.
app.MapPost("/uploads", (HttpContext context) => UploadHttp.Handle(engine, context, new("create")));
app.MapGet(
    "/uploads/{id}",
    (HttpContext context, string id) => UploadHttp.Handle(engine, context, new("probe", id))
);
app.MapPut(
    "/uploads/{id}/parts/{index:int}",
    (HttpContext context, string id, int index) =>
        UploadHttp.Handle(engine, context, new("part", id, index))
);
app.MapPost(
    "/uploads/{id}/complete",
    (HttpContext context, string id) => UploadHttp.Handle(engine, context, new("complete", id))
);
app.MapDelete(
    "/uploads/{id}",
    (HttpContext context, string id) => UploadHttp.Handle(engine, context, new("cancel", id))
);
app.Run();
