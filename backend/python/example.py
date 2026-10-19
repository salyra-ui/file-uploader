import os
from pathlib import Path
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, make_server
from salyra_upload import UploadEngine, DiskSessions, DiskStorage, upload_app


class ThreadingServer(ThreadingMixIn, WSGIServer):
    # one thread per request, so the chunks of one upload are received side by side
    daemon_threads = True


if __name__ == "__main__":
    directory = Path(os.environ.get("UPLOAD_DIRECTORY", ".uploads"))
    engine = UploadEngine(
        DiskSessions(directory / "sessions"),
        DiskStorage(directory / "storage"),
        allow_anonymous=True,  # a local demo: pass authorize in an application
    )
    with make_server(
        os.environ.get("HOST", "127.0.0.1"),
        int(os.environ.get("PORT", "4336")),
        upload_app(engine),
        server_class=ThreadingServer,
    ) as server:
        server.serve_forever()
