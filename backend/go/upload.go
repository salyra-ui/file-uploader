// Package upload implements the salyra-upload/1 contract independently of an HTTP router.
package upload

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

type Error struct {
	Status        int
	Code, Message string
}

func (e *Error) Error() string                    { return e.Message }
func fail(status int, code, message string) error { return &Error{status, code, message} }

type Descriptor struct {
	Protocol     string         `json:"protocol"`
	Name         string         `json:"name"`
	Size         int64          `json:"size"`
	Type         string         `json:"type"`
	LastModified int64          `json:"lastModified"`
	ChunkSize    int64          `json:"chunkSize"`
	Metadata     map[string]any `json:"metadata,omitempty"`
}
type Part struct {
	Index     int             `json:"index"`
	Size      int64           `json:"size"`
	SHA256    string          `json:"sha256"`
	Reference json.RawMessage `json:"reference,omitempty"`
}
type Session struct {
	ID         string          `json:"id"`
	Descriptor Descriptor      `json:"descriptor"`
	ExpiresAt  int64           `json:"expiresAt"`
	State      string          `json:"state"`
	Parts      []Part          `json:"parts"`
	StorageRef json.RawMessage `json:"storageRef"`
	Result     any             `json:"result,omitempty"`
}
type SessionStore interface {
	Lock(context.Context, string) (func(), error)
	Get(context.Context, string) (*Session, error)
	Save(context.Context, *Session) error
	List(context.Context) ([]Session, error)
}
type Storage interface {
	Begin(context.Context, *Session) (json.RawMessage, error)
	WritePart(context.Context, *Session, Part, io.Reader) (Part, error)
	Probe(context.Context, *Session) ([]Part, error)
	Finish(context.Context, *Session, []Part) (any, error)
	Inspect(context.Context, *Session) (any, bool, error)
	Abort(context.Context, *Session) error
}
type Options struct {
	Sessions                  SessionStore
	Storage                   Storage
	MaxFileSize, MaxChunkSize int64
	TTL                       time.Duration
	Scope                     func(context.Context) string
	Authorize                 func(context.Context, string, *Session) error
	// Without Authorize, anyone who can reach the routes can create, read and finish uploads:
	// New refuses that unless AllowAnonymous is set (local demos, tests).
	AllowAnonymous bool
	Validate                  func(context.Context, Descriptor) error
	Notify                    func(context.Context, string, *Session, *Part) error
	OnNotificationError       func(error)
}
type Engine struct{ Options Options }

func New(options Options) *Engine {
	if options.Authorize == nil && !options.AllowAnonymous {
		panic("upload: provide Authorize (and Scope) from your authentication, or set AllowAnonymous for a local demo")
	}
	if options.TTL == 0 {
		options.TTL = 24 * time.Hour
	}
	if options.MaxChunkSize == 0 {
		options.MaxChunkSize = 64 * 1024 * 1024
	}
	return &Engine{options}
}
func (e *Engine) authorize(ctx context.Context, op string, s *Session) error {
	if e.Options.Authorize != nil {
		return e.Options.Authorize(ctx, op, s)
	}
	return nil
}
func (e *Engine) notify(ctx context.Context, event string, s *Session, p *Part) {
	if e.Options.Notify != nil {
		if err := e.Options.Notify(ctx, event, s, p); err != nil && e.Options.OnNotificationError != nil {
			e.Options.OnNotificationError(err)
		}
	}
}
func sameDescriptor(a, b Descriptor) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}
func (e *Engine) CreateUpload(ctx context.Context, d Descriptor, key string) (*Session, error) {
	if err := e.authorize(ctx, "create", nil); err != nil {
		return nil, err
	}
	if d.Protocol != "salyra-upload/1" || d.ChunkSize < 1 || d.ChunkSize > e.Options.MaxChunkSize || d.Size < 0 || d.LastModified < 0 || d.Size > 9007199254740991 || d.LastModified > 9007199254740991 || utf8.RuneCountInString(d.Name) > 1024 || key == "" || len(key) > 200 {
		return nil, fail(400, "DESCRIPTOR", "Invalid upload configuration")
	}
	if e.Options.MaxFileSize > 0 && d.Size > e.Options.MaxFileSize {
		return nil, fail(413, "FILE_SIZE", "File exceeds the configured limit")
	}
	if d.Size/d.ChunkSize > 100000 || (d.Size/d.ChunkSize == 100000 && d.Size%d.ChunkSize != 0) {
		return nil, fail(413, "PART_COUNT", "Too many chunks")
	}
	if e.Options.Validate != nil {
		if err := e.Options.Validate(ctx, d); err != nil {
			return nil, err
		}
	}
	scope := ""
	if e.Options.Scope != nil {
		scope = e.Options.Scope(ctx)
	}
	sum := sha256.Sum256([]byte(scope + "\x00" + key))
	id := hex.EncodeToString(sum[:])
	unlock, err := e.Options.Sessions.Lock(ctx, id)
	if err != nil {
		return nil, err
	}
	defer unlock()
	existing, err := e.Options.Sessions.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if err = e.authorize(ctx, "create", existing); err != nil {
			return nil, err
		}
		if !sameDescriptor(existing.Descriptor, d) {
			return nil, fail(409, "KEY_CONFLICT", "Key belongs to another file")
		}
		if existing.ExpiresAt <= time.Now().UnixMilli() && existing.State == "finalizing" {
			if err = e.reconcile(ctx, existing); err != nil {
				return nil, err
			}
		}
		if existing.ExpiresAt <= time.Now().UnixMilli() && existing.State != "completed" {
			return nil, fail(410, "EXPIRED", "Session expired")
		}
		return existing, nil
	}
	s := &Session{ID: id, Descriptor: d, ExpiresAt: time.Now().Add(e.Options.TTL).UnixMilli(), State: "open", Parts: []Part{}}
	s.StorageRef, err = e.Options.Storage.Begin(ctx, s)
	if err != nil {
		return nil, err
	}
	if err = e.Options.Sessions.Save(ctx, s); err != nil {
		return nil, err
	}
	e.notify(ctx, "created", s, nil)
	return s, nil
}
func (e *Engine) get(ctx context.Context, id, op string) (*Session, error) {
	s, err := e.Options.Sessions.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return nil, fail(404, "NOT_FOUND", "Upload session was not found")
	}
	if err = e.authorize(ctx, op, s); err != nil {
		return nil, err
	}
	if s.State == "expired" {
		return nil, fail(410, "EXPIRED", "Session expired")
	}
	if s.ExpiresAt <= time.Now().UnixMilli() && s.State != "completed" && s.State != "canceled" {
		if s.State == "finalizing" {
			if err = e.reconcile(ctx, s); err != nil {
				return nil, err
			}
			if s.State == "completed" {
				return s, nil
			}
		}
		if err = e.Options.Storage.Abort(ctx, s); err != nil {
			return nil, err
		}
		s.State = "expired"
		if err = e.Options.Sessions.Save(ctx, s); err != nil {
			return nil, err
		}
		e.notify(ctx, "expired", s, nil)
		return nil, fail(410, "EXPIRED", "Session expired")
	}
	return s, nil
}
func (e *Engine) reconcile(ctx context.Context, s *Session) error {
	if s.State == "completed" || s.State == "canceled" {
		return nil
	}
	result, found, err := e.Options.Storage.Inspect(ctx, s)
	if err != nil {
		return err
	}
	if found {
		s.State = "completed"
		s.Result = result
		return e.Options.Sessions.Save(ctx, s)
	}
	parts, err := e.Options.Storage.Probe(ctx, s)
	if err != nil {
		return err
	}
	s.Parts = parts
	return e.Options.Sessions.Save(ctx, s)
}
func (e *Engine) GetUpload(ctx context.Context, id string) (*Session, error) {
	unlock, err := e.Options.Sessions.Lock(ctx, id)
	if err != nil {
		return nil, err
	}
	defer unlock()
	s, err := e.get(ctx, id, "probe")
	if err != nil {
		return nil, err
	}
	err = e.reconcile(ctx, s)
	return s, err
}
func (e *Engine) ReceivePart(ctx context.Context, id string, index int, checksum string, body io.Reader) (Part, error) {
	unlock, err := e.Options.Sessions.Lock(ctx, id)
	if err != nil {
		return Part{}, err
	}
	defer unlock()
	s, err := e.get(ctx, id, "part")
	if err != nil {
		return Part{}, err
	}
	if s.State != "open" {
		return Part{}, fail(409, "STATE", "Upload does not accept chunks")
	}
	count := (s.Descriptor.Size + s.Descriptor.ChunkSize - 1) / s.Descriptor.ChunkSize
	if count < 1 {
		count = 1
	}
	decoded, err := hex.DecodeString(checksum)
	if err != nil || len(decoded) != 32 || strings.ToLower(checksum) != checksum || index < 0 || int64(index) >= count {
		return Part{}, fail(400, "PART", "Invalid chunk or checksum")
	}
	size := s.Descriptor.ChunkSize
	if remaining := s.Descriptor.Size - int64(index)*size; remaining < size {
		size = remaining
	}
	p := Part{Index: index, Size: size, SHA256: checksum}
	saved, err := e.Options.Storage.WritePart(ctx, s, p, body)
	if err != nil {
		return Part{}, err
	}
	for _, old := range s.Parts {
		if old.Index == index {
			if old.SHA256 != saved.SHA256 || old.Size != saved.Size {
				return Part{}, fail(409, "PART_CONFLICT", "Chunk contains different data")
			}
			return old, nil
		}
	}
	s.Parts = append(s.Parts, saved)
	if err = e.Options.Sessions.Save(ctx, s); err != nil {
		return Part{}, err
	}
	e.notify(ctx, "part-stored", s, &saved)
	return saved, nil
}
func (e *Engine) FinishUpload(ctx context.Context, id string) (any, error) {
	unlock, err := e.Options.Sessions.Lock(ctx, id)
	if err != nil {
		return nil, err
	}
	defer unlock()
	s, err := e.get(ctx, id, "complete")
	if err != nil {
		return nil, err
	}
	if err = e.reconcile(ctx, s); err != nil {
		return nil, err
	}
	if s.State == "completed" {
		return s.Result, nil
	}
	if s.State == "canceled" {
		return nil, fail(409, "CANCELED", "Upload was canceled")
	}
	count := (s.Descriptor.Size + s.Descriptor.ChunkSize - 1) / s.Descriptor.ChunkSize
	if count < 1 {
		count = 1
	}
	if int64(len(s.Parts)) != count {
		return nil, fail(409, "INCOMPLETE", "Upload is missing chunks")
	}
	for i, p := range s.Parts {
		expected := s.Descriptor.ChunkSize
		if remaining := s.Descriptor.Size - int64(i)*expected; remaining < expected {
			expected = remaining
		}
		if p.Index != i || p.Size != expected {
			return nil, fail(409, "MANIFEST", "Invalid part manifest")
		}
	}
	s.State = "finalizing"
	if err = e.Options.Sessions.Save(ctx, s); err != nil {
		return nil, err
	}
	result, err := e.Options.Storage.Finish(ctx, s, s.Parts)
	if err != nil {
		var found bool
		result, found, err = e.Options.Storage.Inspect(ctx, s)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, fail(502, "FINALIZE", "Could not finalize upload")
		}
	}
	s.Result = result
	s.State = "completed"
	if err = e.Options.Sessions.Save(ctx, s); err != nil {
		return nil, err
	}
	e.notify(ctx, "completed", s, nil)
	return result, nil
}
func (e *Engine) CancelUpload(ctx context.Context, id string) error {
	unlock, err := e.Options.Sessions.Lock(ctx, id)
	if err != nil {
		return err
	}
	defer unlock()
	s, err := e.get(ctx, id, "cancel")
	if err != nil {
		return err
	}
	if err = e.reconcile(ctx, s); err != nil {
		return err
	}
	if s.State == "completed" {
		return fail(409, "COMPLETED", "Remove completed files through the application")
	}
	if err = e.Options.Storage.Abort(ctx, s); err != nil {
		return err
	}
	s.State = "canceled"
	s.Parts = []Part{}
	if err = e.Options.Sessions.Save(ctx, s); err != nil {
		return err
	}
	e.notify(ctx, "canceled", s, nil)
	return nil
}

type RouteMatch struct {
	Operation, ID string
	Index         int
}
type Handler struct {
	Engine   *Engine
	Match    func(*http.Request) (RouteMatch, bool)
	BasePath string
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var route RouteMatch
	var matched bool
	if h.Match != nil {
		route, matched = h.Match(r)
	} else {
		base := strings.TrimSuffix(h.BasePath, "/")
		if base == "" {
			base = "/uploads"
		}
		rest := strings.TrimPrefix(r.URL.Path, base)
		if rest == "" && r.Method == "POST" {
			route.Operation = "create"
			matched = true
		} else if strings.HasPrefix(r.URL.Path, base+"/") {
			p := strings.Split(strings.TrimPrefix(rest, "/"), "/")
			route.ID = p[0]
			if len(p) == 1 && r.Method == "GET" {
				route.Operation = "probe"
				matched = true
			}
			if len(p) == 1 && r.Method == "DELETE" {
				route.Operation = "cancel"
				matched = true
			}
			if len(p) == 2 && p[1] == "complete" && r.Method == "POST" {
				route.Operation = "complete"
				matched = true
			}
			if len(p) == 3 && p[1] == "parts" && r.Method == "PUT" {
				if _, err := fmt.Sscanf(p[2], "%d", &route.Index); err == nil {
					route.Operation = "part"
					matched = true
				}
			}
		}
	}
	if !matched {
		http.NotFound(w, r)
		return
	}
	var result any
	var err error
	ctx := r.Context()
	switch route.Operation {
	case "create":
		// a cross-site form can post text/plain without a CORS preflight; it cannot send this type
		if media := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])); media != "application/json" {
			err = fail(415, "CONTENT_TYPE", "Upload metadata must be sent as application/json")
			break
		}
		var d Descriptor
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		if err = decoder.Decode(&d); err == nil {
			var session *Session
			session, err = h.Engine.CreateUpload(ctx, d, r.Header.Get("Idempotency-Key"))
			if err == nil {
				result = map[string]any{"id": session.ID, "chunkSize": session.Descriptor.ChunkSize, "expiresAt": session.ExpiresAt}
			}
		} else {
			err = fail(400, "JSON", "Invalid JSON body")
		}
	case "probe":
		var s *Session
		s, err = h.Engine.GetUpload(ctx, route.ID)
		if err == nil {
			parts := []Part{}
			for _, p := range s.Parts {
				p.Reference = nil
				parts = append(parts, p)
			}
			result = map[string]any{"status": s.State, "parts": parts, "expiresAt": s.ExpiresAt}
			if s.State == "completed" {
				result.(map[string]any)["result"] = s.Result
			}
		}
	case "part":
		var p Part
		p, err = h.Engine.ReceivePart(ctx, route.ID, route.Index, r.Header.Get("Upload-Checksum"), r.Body)
		p.Reference = nil
		result = p
	case "complete":
		result, err = h.Engine.FinishUpload(ctx, route.ID)
	case "cancel":
		err = h.Engine.CancelUpload(ctx, route.ID)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		var typed *Error
		status := 500
		code, message := "INTERNAL", "Upload operation failed"
		if errors.As(err, &typed) {
			status, code, message = typed.Status, typed.Code, typed.Message
		}
		w.WriteHeader(status)
		result = map[string]any{"code": code, "message": message}
	}
	json.NewEncoder(w).Encode(result)
}
