import json
import re
from http import HTTPStatus
from .engine import UploadError


class LimitedBody:
    def __init__(self, stream, length):
        self.stream, self.remaining = stream, length

    def read(self, size):
        if self.remaining <= 0:
            return b""
        data = self.stream.read(min(size, self.remaining))
        self.remaining -= len(data)
        return data


# A custom match callback returns (operation, id, index). The environment is passed as application context.
def upload_app(engine, *, base_path="/uploads", match=None):
    def application(environ, start_response):
        try:
            method, path = environ["REQUEST_METHOD"], environ["PATH_INFO"]
            if match:
                operation, identifier, index = match(environ)
            elif path == base_path and method == "POST":
                operation, identifier, index = "create", None, None
            else:
                route = re.fullmatch(
                    re.escape(base_path)
                    + r"/([a-zA-Z0-9_-]{1,100})(?:/(complete|parts)/(\d+)|/(complete))?",
                    path,
                )
                if not route:
                    raise UploadError(404, "NOT_FOUND", "Route was not found")
                identifier, kind, number, complete = route.groups()
                if kind == "parts" and number is not None and method == "PUT":
                    operation, index = "part", int(number)
                elif (kind == "complete" or complete) and method == "POST":
                    operation, index = "complete", None
                elif not kind and not complete and method in ("GET", "DELETE"):
                    operation, index = ("probe" if method == "GET" else "cancel"), None
                else:
                    raise UploadError(404, "NOT_FOUND", "Route was not found")
            length = int(environ.get("CONTENT_LENGTH") or 0)
            body = LimitedBody(environ["wsgi.input"], length)
            if operation == "create":
                # a cross-site form can post text/plain without a CORS preflight, not this type
                media = environ.get("CONTENT_TYPE", "").split(";")[0].strip().lower()
                if media != "application/json":
                    raise UploadError(
                        415,
                        "CONTENT_TYPE",
                        "Upload metadata must be sent as application/json",
                    )
                if length > 65536:
                    raise UploadError(413, "JSON_SIZE", "Upload metadata is too large")
                try:
                    descriptor = json.loads(body.read(length))
                except (ValueError, UnicodeDecodeError):
                    raise UploadError(400, "JSON", "Invalid JSON body")
                result = engine.create_upload(
                    descriptor, environ.get("HTTP_IDEMPOTENCY_KEY", ""), environ
                )
            elif operation == "probe":
                result = engine.get_upload(identifier, environ)
            elif operation == "part":
                result = engine.receive_part(
                    identifier,
                    index,
                    environ.get("HTTP_UPLOAD_CHECKSUM", ""),
                    body,
                    environ,
                )
            elif operation == "complete":
                result = engine.finish_upload(identifier, environ)
            else:
                result = engine.cancel_upload(identifier, environ)
            status = 200
        except UploadError as error:
            status, result = error.status, {"code": error.code, "message": str(error)}
        except Exception:
            status, result = (
                500,
                {"code": "INTERNAL", "message": "Upload operation failed"},
            )
        encoded = json.dumps(result).encode()
        start_response(
            f"{status} {HTTPStatus(status).phrase}",
            [
                ("Content-Type", "application/json"),
                ("Cache-Control", "no-store"),
                ("Content-Length", str(len(encoded))),
            ],
        )
        return [encoded]

    return application
