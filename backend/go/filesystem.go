package upload

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"time"
)

var safeID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

func safe(id string) error {
	if !safeID.MatchString(id) {
		return fail(400, "ID", "Invalid upload identifier")
	}
	return nil
}
func atomicJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".json-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(data); err == nil {
		err = temp.Sync()
	}
	if closed := temp.Close(); err == nil {
		err = closed
	}
	if err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}

type DiskSessions struct{ Directory string }

func (d DiskSessions) Lock(ctx context.Context, id string) (func(), error) {
	if err := safe(id); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(d.Directory, 0700); err != nil {
		return nil, err
	}
	return lockFile(ctx, filepath.Join(d.Directory, id+".lock"))
}
func (d DiskSessions) Get(ctx context.Context, id string) (*Session, error) {
	if err := safe(id); err != nil {
		return nil, err
	}
	bytes, err := os.ReadFile(filepath.Join(d.Directory, id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s Session
	err = json.Unmarshal(bytes, &s)
	return &s, err
}
func (d DiskSessions) Save(ctx context.Context, s *Session) error {
	if err := safe(s.ID); err != nil {
		return err
	}
	if err := atomicJSON(filepath.Join(d.Directory, s.ID+".json"), s); err != nil {
		return err
	}
	if s.State == "completed" || s.State == "canceled" || s.State == "expired" {
		d.dropChunkLocks(s)
	}
	return nil
}

// dropChunkLocks removes the lock files of a finished upload's chunk numbers. A chunk
// request still streaming then is refused at its record, so the lock is no longer needed.
func (d DiskSessions) dropChunkLocks(s *Session) {
	if s.Descriptor.ChunkSize < 1 {
		return
	}
	count := (s.Descriptor.Size + s.Descriptor.ChunkSize - 1) / s.Descriptor.ChunkSize
	for i := int64(0); i < count || i == 0; i++ {
		os.Remove(filepath.Join(d.Directory, chunkLock(s.ID, int(i))+".lock"))
	}
}
func (d DiskSessions) List(ctx context.Context) ([]Session, error) {
	entries, err := os.ReadDir(d.Directory)
	if errors.Is(err, os.ErrNotExist) {
		return []Session{}, nil
	}
	if err != nil {
		return nil, err
	}
	items := []Session{}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".json" {
			s, err := d.Get(ctx, entry.Name()[:len(entry.Name())-5])
			if err != nil {
				return nil, err
			}
			items = append(items, *s)
		}
	}
	return items, nil
}

type DiskStorage struct{ Directory string }

func (d DiskStorage) directory(s *Session) string { return filepath.Join(d.Directory, "parts", s.ID) }
func (d DiskStorage) result(s *Session) string    { return filepath.Join(d.Directory, "files", s.ID) }
func (d DiskStorage) Begin(ctx context.Context, s *Session) (json.RawMessage, error) {
	if err := safe(s.ID); err != nil {
		return nil, err
	}
	err := os.MkdirAll(d.directory(s), 0700)
	return json.RawMessage(`{"version":1}`), err
}
func (d DiskStorage) WritePart(ctx context.Context, s *Session, p Part, body io.Reader) (Part, error) {
	path := filepath.Join(d.directory(s), strconv.Itoa(p.Index))
	receipt := path + ".receipt.json"
	if bytes, err := os.ReadFile(receipt); err == nil {
		var old Part
		if err = json.Unmarshal(bytes, &old); err != nil {
			return Part{}, err
		}
		if old.Size != p.Size || old.SHA256 != p.SHA256 {
			return Part{}, fail(409, "PART_CONFLICT", "Chunk contains different data")
		}
	}
	if _, err := os.Stat(path); err == nil {
		old, err := measure(ctx, path, p.Index)
		if err != nil {
			return Part{}, err
		}
		if old.Size != p.Size || old.SHA256 != p.SHA256 {
			return Part{}, fail(409, "PART_CONFLICT", "Chunk contains different data")
		}
	}
	temp, err := os.CreateTemp(d.directory(s), ".part-*")
	if err != nil {
		return Part{}, err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(contextReader{ctx, body}, p.Size+1))
	if err != nil {
		return Part{}, err
	}
	if n > p.Size {
		return Part{}, fail(413, "PART_SIZE", "Chunk exceeds expected size")
	}
	if n != p.Size || hex.EncodeToString(hash.Sum(nil)) != p.SHA256 {
		return Part{}, fail(422, "CHECKSUM", "Chunk checksum does not match")
	}
	if err = temp.Sync(); err != nil {
		return Part{}, err
	}
	if err = temp.Close(); err != nil {
		return Part{}, err
	}
	if err = os.Rename(temp.Name(), path); err != nil {
		return Part{}, err
	}
	p.Reference = json.RawMessage(fmt.Sprintf(`{"version":1,"index":%d}`, p.Index))
	if err = atomicJSON(receipt, p); err != nil {
		return Part{}, err
	}
	return p, nil
}

type contextReader struct {
	ctx    context.Context
	source io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(p)
}
func measure(ctx context.Context, path string, index int) (Part, error) {
	file, err := os.Open(path)
	if err != nil {
		return Part{}, err
	}
	defer file.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, contextReader{ctx, file})
	return Part{Index: index, Size: n, SHA256: hex.EncodeToString(hash.Sum(nil)), Reference: json.RawMessage(fmt.Sprintf(`{"version":1,"index":%d}`, index))}, err
}
func (d DiskStorage) Probe(ctx context.Context, s *Session) ([]Part, error) {
	entries, err := os.ReadDir(d.directory(s))
	if errors.Is(err, os.ErrNotExist) {
		return []Part{}, nil
	}
	if err != nil {
		return nil, err
	}
	parts := []Part{}
	for _, entry := range entries {
		index, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		path := filepath.Join(d.directory(s), entry.Name())
		var p Part
		bytes, err := os.ReadFile(path + ".receipt.json")
		if err == nil {
			err = json.Unmarshal(bytes, &p)
		} else if errors.Is(err, os.ErrNotExist) {
			p, err = measure(ctx, path, index)
			if err == nil {
				err = atomicJSON(path+".receipt.json", p)
			}
		}
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if p.Size != info.Size() {
			return nil, fail(500, "STORAGE_CHECKPOINT", "Stored chunk changed")
		}
		parts = append(parts, p)
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].Index < parts[j].Index })
	return parts, nil
}
func (d DiskStorage) Inspect(ctx context.Context, s *Session) (any, bool, error) {
	p, err := measure(ctx, d.result(s), 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if p.Size != s.Descriptor.Size {
		return nil, false, fail(500, "RESULT_SIZE", "Completed file size does not match")
	}
	return map[string]any{"id": s.ID, "size": p.Size, "sha256": p.SHA256}, true, nil
}
func (d DiskStorage) Finish(ctx context.Context, s *Session, parts []Part) (any, error) {
	if result, found, err := d.Inspect(ctx, s); err != nil || found {
		return result, err
	}
	if err := os.MkdirAll(filepath.Dir(d.result(s)), 0700); err != nil {
		return nil, err
	}
	out, err := os.CreateTemp(filepath.Dir(d.result(s)), ".result-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	hash := sha256.New()
	var total int64
	for _, p := range parts {
		part, err := os.Open(filepath.Join(d.directory(s), strconv.Itoa(p.Index)))
		if err != nil {
			return nil, err
		}
		partHash := sha256.New()
		n, err := io.Copy(io.MultiWriter(out, hash, partHash), contextReader{ctx, part})
		part.Close()
		if err != nil {
			return nil, err
		}
		if n != p.Size || hex.EncodeToString(partHash.Sum(nil)) != p.SHA256 {
			return nil, fail(422, "CHECKSUM", "Saved chunk changed")
		}
		total += n
	}
	if total != s.Descriptor.Size {
		return nil, fail(422, "SIZE", "Assembled size does not match")
	}
	if err = out.Sync(); err != nil {
		return nil, err
	}
	if err = out.Close(); err != nil {
		return nil, err
	}
	if err = os.Rename(out.Name(), d.result(s)); err != nil {
		return nil, err
	}
	if err = os.RemoveAll(d.directory(s)); err != nil {
		return nil, err
	}
	return map[string]any{"id": s.ID, "size": total, "sha256": hex.EncodeToString(hash.Sum(nil))}, nil
}
func (d DiskStorage) Abort(ctx context.Context, s *Session) error {
	return os.RemoveAll(d.directory(s))
}

var _ = time.Second
