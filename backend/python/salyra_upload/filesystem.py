import os
import json
import hashlib
import re
import tempfile
import shutil
from pathlib import Path
from contextlib import contextmanager
from .engine import UploadError, chunk_lock


def safe(identifier):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", identifier):
        raise UploadError(400, "ID", "Invalid upload identifier")
    return identifier


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", delete=False) as output:
        temp = Path(output.name)
        try:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        except Exception:
            temp.unlink(missing_ok=True)
            raise
    os.replace(temp, path)


def measure(path, index=0):
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as stream:
        while data := stream.read(65536):
            digest.update(data)
            size += len(data)
    return {
        "index": index,
        "size": size,
        "sha256": digest.hexdigest(),
        "reference": {"version": 1, "index": index},
    }


class DiskSessions:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def lock(self, identifier):
        import fcntl

        with (self.directory / (safe(identifier) + ".lock")).open("a+b") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def get(self, identifier):
        try:
            return json.loads(
                (self.directory / (safe(identifier) + ".json")).read_text()
            )
        except FileNotFoundError:
            return None

    def save(self, session):
        atomic_json(self.directory / (safe(session["id"]) + ".json"), session)
        if session.get("state") in ("completed", "canceled", "expired"):
            # Nothing is received for a finished upload any more: its chunk locks can go. A
            # chunk request still streaming is refused at its record.
            descriptor = session["descriptor"]
            count = max(1, -(-descriptor["size"] // max(1, descriptor["chunkSize"])))
            for index in range(count):
                (self.directory / (chunk_lock(session["id"], index) + ".lock")).unlink(
                    missing_ok=True
                )

    def list(self):
        return [json.loads(path.read_text()) for path in self.directory.glob("*.json")]


class DiskStorage:
    def __init__(self, directory):
        self.directory = Path(directory)

    def _parts(self, session):
        return self.directory / "parts" / safe(session["id"])

    def _result(self, session):
        return self.directory / "files" / safe(session["id"])

    def begin(self, session, context):
        self._parts(session).mkdir(parents=True, exist_ok=True)
        return {"version": 1, "id": session["id"]}

    def write_part(self, session, part, body, context):
        path = self._parts(session) / str(part["index"])
        if path.exists():
            saved = measure(path, part["index"])
            if saved["sha256"] != part["sha256"] or saved["size"] != part["size"]:
                raise UploadError(
                    409, "PART_CONFLICT", "Chunk already contains different data"
                )
        digest, size = hashlib.sha256(), 0
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
            temp = Path(output.name)
            try:
                while data := body.read(min(65536, part["size"] - size + 1)):
                    size += len(data)
                    if size > part["size"]:
                        raise UploadError(
                            413, "PART_SIZE", "Chunk exceeds expected size"
                        )
                    digest.update(data)
                    output.write(data)
                if size != part["size"] or digest.hexdigest() != part["sha256"]:
                    raise UploadError(422, "CHECKSUM", "Chunk checksum does not match")
                output.flush()
                os.fsync(output.fileno())
            except Exception:
                temp.unlink(missing_ok=True)
                raise
        os.replace(temp, path)
        saved = {**part, "reference": {"version": 1, "index": part["index"]}}
        atomic_json(Path(str(path) + ".receipt.json"), saved)
        return saved

    def probe(self, session, context):
        directory = self._parts(session)
        if not directory.exists():
            return []
        parts = []
        for path in directory.iterdir():
            if not path.name.isdecimal():
                continue
            receipt = Path(str(path) + ".receipt.json")
            if receipt.exists():
                saved = json.loads(receipt.read_text())
            else:
                saved = measure(path, int(path.name))
                atomic_json(receipt, saved)
            if saved["size"] != path.stat().st_size:
                raise UploadError(500, "STORAGE_CHECKPOINT", "Stored chunk changed")
            parts.append(saved)
        return sorted(parts, key=lambda part: part["index"])

    def inspect(self, session, context):
        path = self._result(session)
        if not path.exists():
            return False, None
        saved = measure(path)
        if saved["size"] != session["descriptor"]["size"]:
            raise UploadError(500, "RESULT_SIZE", "Completed file size does not match")
        return True, {
            "id": session["id"],
            "size": saved["size"],
            "sha256": saved["sha256"],
        }

    def finish(self, session, parts, context):
        found, result = self.inspect(session, context)
        if found:
            return result
        path = self._result(session)
        path.parent.mkdir(parents=True, exist_ok=True)
        digest, total = hashlib.sha256(), 0
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
            temp = Path(output.name)
            try:
                for part in parts:
                    part_digest, size = hashlib.sha256(), 0
                    with (self._parts(session) / str(part["index"])).open(
                        "rb"
                    ) as stream:
                        while data := stream.read(65536):
                            digest.update(data)
                            part_digest.update(data)
                            output.write(data)
                            size += len(data)
                    if (
                        size != part["size"]
                        or part_digest.hexdigest() != part["sha256"]
                    ):
                        raise UploadError(422, "CHECKSUM", "Saved chunk changed")
                    total += size
                if total != session["descriptor"]["size"]:
                    raise UploadError(422, "SIZE", "Assembled size does not match")
                output.flush()
                os.fsync(output.fileno())
            except Exception:
                temp.unlink(missing_ok=True)
                raise
        os.replace(temp, path)
        shutil.rmtree(self._parts(session), ignore_errors=True)
        return {"id": session["id"], "size": total, "sha256": digest.hexdigest()}

    def abort(self, session, context):
        shutil.rmtree(self._parts(session), ignore_errors=False) if self._parts(
            session
        ).exists() else None
