import hashlib
import json
import math
import time
from typing import Protocol, BinaryIO, ContextManager, Any


class UploadError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


class SessionStore(Protocol):
    def lock(self, key: str) -> ContextManager: ...
    def get(self, key: str) -> dict | None: ...
    def save(self, session: dict) -> None: ...
    def list(self) -> list[dict]: ...


class Storage(Protocol):
    def begin(self, session: dict, context: Any) -> Any: ...
    def write_part(
        self, session: dict, part: dict, body: BinaryIO, context: Any
    ) -> dict: ...
    def probe(self, session: dict, context: Any) -> list[dict]: ...
    def inspect(self, session: dict, context: Any) -> tuple[bool, Any]: ...
    def finish(self, session: dict, parts: list[dict], context: Any) -> Any: ...
    def abort(self, session: dict, context: Any) -> None: ...


class UploadEngine:
    def __init__(
        self,
        sessions: SessionStore,
        storage: Storage,
        *,
        ttl=86400,
        max_file_size=None,
        max_chunk_size=64 * 1024 * 1024,
        scope=None,
        authorize=None,
        allow_anonymous=False,
        validate=None,
        notify=None,
        notification_error=None,
    ):
        # without authorize anyone who reaches the routes can create, read and finish uploads
        if authorize is None and not allow_anonymous:
            raise ValueError(
                "Provide authorize (and scope) from your authentication, "
                "or allow_anonymous=True for a local demo"
            )
        self.sessions, self.storage, self.ttl = sessions, storage, ttl
        self.max_file_size, self.max_chunk_size = max_file_size, max_chunk_size
        self.scope, self.authorize, self.validate = scope, authorize, validate
        self.notify, self.notification_error = notify, notification_error

    def _authorize(self, operation, session, context):
        if self.authorize:
            self.authorize(operation, session, context)

    def _notify(self, event, session, context, part=None):
        if not self.notify:
            return
        try:
            self.notify(
                {
                    "id": f"{session['id']}:{event}"
                    + (f":{part['index']}" if part else ""),
                    "type": event,
                    "session": session,
                    "part": part,
                },
                context,
            )
        except Exception as error:
            if self.notification_error:
                self.notification_error(error)

    def create_upload(self, descriptor, key, context=None):
        self._authorize("create", None, context)
        integer = lambda value: type(value) is int and 0 <= value <= 9007199254740991
        if (
            not isinstance(descriptor, dict)
            or descriptor.get("protocol") != "salyra-upload/1"
            or not isinstance(descriptor.get("name"), str)
            or len(descriptor["name"]) > 1024
            or not isinstance(descriptor.get("type"), str)
            or not integer(descriptor.get("size"))
            or not integer(descriptor.get("lastModified"))
            or not integer(descriptor.get("chunkSize"))
            or not 1 <= descriptor["chunkSize"] <= self.max_chunk_size
        ):
            raise UploadError(400, "DESCRIPTOR", "Invalid upload configuration")
        if self.max_file_size is not None and descriptor["size"] > self.max_file_size:
            raise UploadError(413, "FILE_SIZE", "File exceeds its limit")
        if max(1, math.ceil(descriptor["size"] / descriptor["chunkSize"])) > 100000:
            raise UploadError(413, "PART_COUNT", "Too many chunks")
        if not isinstance(key, str) or not 1 <= len(key) <= 200:
            raise UploadError(400, "IDEMPOTENCY_KEY", "An idempotency key is required")
        if self.validate:
            self.validate(descriptor, context)
        scope = self.scope(context) if self.scope else ""
        identifier = hashlib.sha256(
            json.dumps([scope, key], separators=(",", ":")).encode()
        ).hexdigest()
        with self.sessions.lock(identifier):
            existing = self.sessions.get(identifier)
            if existing:
                self._authorize("create", existing, context)
                if existing["descriptor"] != descriptor:
                    raise UploadError(
                        409, "KEY_CONFLICT", "Key belongs to another file"
                    )
                if existing["expiresAt"] <= time.time() * 1000 and existing["state"] == "finalizing":
                    self._reconcile(existing, context)
                if (
                    existing["expiresAt"] <= time.time() * 1000
                    and existing["state"] != "completed"
                ):
                    raise UploadError(410, "EXPIRED", "Session expired")
                return {
                    "id": identifier,
                    "chunkSize": descriptor["chunkSize"],
                    "expiresAt": existing["expiresAt"],
                }
            session = {
                "id": identifier,
                "descriptor": descriptor,
                "expiresAt": int((time.time() + self.ttl) * 1000),
                "state": "open",
                "parts": [],
            }
            session["storageRef"] = self.storage.begin(session, context)
            self.sessions.save(session)
            self._notify("created", session, context)
            return {
                "id": identifier,
                "chunkSize": descriptor["chunkSize"],
                "expiresAt": session["expiresAt"],
            }

    def _get(self, identifier, operation, context):
        session = self.sessions.get(identifier)
        if not session:
            raise UploadError(404, "NOT_FOUND", "Upload session was not found")
        self._authorize(operation, session, context)
        if session["state"] == "expired":
            raise UploadError(410, "EXPIRED", "Session expired")
        if session["expiresAt"] <= time.time() * 1000 and session["state"] not in (
            "completed",
            "canceled",
        ):
            if session["state"] == "finalizing":
                self._reconcile(session, context)
                if session["state"] == "completed":
                    return session
            self.storage.abort(session, context)
            session["state"] = "expired"
            self.sessions.save(session)
            self._notify("expired", session, context)
            raise UploadError(410, "EXPIRED", "Session expired")
        return session

    def _reconcile(self, session, context):
        if session["state"] in ("completed", "canceled"):
            return
        found, result = self.storage.inspect(session, context)
        if found:
            session["state"], session["result"] = "completed", result
        else:
            parts = sorted(
                self.storage.probe(session, context), key=lambda part: part["index"]
            )
            descriptor = session["descriptor"]
            count = max(1, math.ceil(descriptor["size"] / descriptor["chunkSize"]))
            indexes = set()
            for part in parts:
                index = part["index"]
                if (
                    index in indexes
                    or not 0 <= index < count
                    or part["size"]
                    != min(
                        descriptor["chunkSize"],
                        descriptor["size"] - index * descriptor["chunkSize"],
                    )
                ):
                    raise UploadError(
                        500, "STORAGE_CHECKPOINT", "Storage returned an invalid part"
                    )
                indexes.add(index)
            session["parts"] = parts
        self.sessions.save(session)

    def get_upload(self, identifier, context=None):
        with self.sessions.lock(identifier):
            session = self._get(identifier, "probe", context)
            self._reconcile(session, context)
            result = {
                "status": session["state"],
                "parts": [
                    {key: part[key] for key in ("index", "size", "sha256")}
                    for part in session["parts"]
                ],
                "expiresAt": session["expiresAt"],
            }
            if session["state"] == "completed":
                result["result"] = session["result"]
            return result

    def receive_part(self, identifier, index, checksum, body, context=None):
        with self.sessions.lock(identifier):
            session = self._get(identifier, "part", context)
            if session["state"] != "open":
                raise UploadError(409, "STATE", "Upload does not accept chunks")
            descriptor = session["descriptor"]
            count = max(1, math.ceil(descriptor["size"] / descriptor["chunkSize"]))
            if (
                type(index) is not int
                or not 0 <= index < count
                or not isinstance(checksum, str)
                or len(checksum) != 64
                or any(c not in "0123456789abcdef" for c in checksum)
            ):
                raise UploadError(400, "PART", "Invalid chunk or checksum")
            part = {
                "index": index,
                "size": min(
                    descriptor["chunkSize"],
                    descriptor["size"] - index * descriptor["chunkSize"],
                ),
                "sha256": checksum,
            }
            saved = self.storage.write_part(session, part, body, context)
            session["parts"] = sorted(
                [p for p in session["parts"] if p["index"] != index] + [saved],
                key=lambda p: p["index"],
            )
            self.sessions.save(session)
            self._notify("part-stored", session, context, saved)
            return {key: saved[key] for key in ("index", "size", "sha256")}

    def finish_upload(self, identifier, context=None):
        with self.sessions.lock(identifier):
            session = self._get(identifier, "complete", context)
            self._reconcile(session, context)
            if session["state"] == "completed":
                return session["result"]
            if session["state"] == "canceled":
                raise UploadError(409, "CANCELED", "Upload was canceled")
            descriptor = session["descriptor"]
            count = max(1, math.ceil(descriptor["size"] / descriptor["chunkSize"]))
            if len(session["parts"]) != count or any(
                p["index"] != i for i, p in enumerate(session["parts"])
            ):
                raise UploadError(409, "INCOMPLETE", "Upload is missing chunks")
            session["state"] = "finalizing"
            self.sessions.save(session)
            try:
                result = self.storage.finish(session, session["parts"], context)
            except Exception:
                found, result = self.storage.inspect(session, context)
                if not found:
                    raise
            session["state"], session["result"] = "completed", result
            self.sessions.save(session)
            self._notify("completed", session, context)
            return result

    def cancel_upload(self, identifier, context=None):
        with self.sessions.lock(identifier):
            session = self._get(identifier, "cancel", context)
            self._reconcile(session, context)
            if session["state"] == "completed":
                raise UploadError(
                    409, "COMPLETED", "Remove completed files through the application"
                )
            self.storage.abort(session, context)
            session["state"], session["parts"] = "canceled", []
            self.sessions.save(session)
            self._notify("canceled", session, context)
