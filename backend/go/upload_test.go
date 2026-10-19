package upload

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func checksum(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}
func TestResumeAndFinalize(t *testing.T) {
	dir := t.TempDir()
	engine := New(Options{AllowAnonymous: true, Sessions: DiskSessions{Directory: filepath.Join(dir, "sessions")}, Storage: DiskStorage{Directory: filepath.Join(dir, "storage")}})
	ctx := context.Background()
	d := Descriptor{Protocol: "salyra-upload/1", Name: "file.txt", Size: 8, ChunkSize: 4}
	s, err := engine.CreateUpload(ctx, d, "one")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = engine.ReceivePart(ctx, s.ID, 1, checksum("efgh"), strings.NewReader("efgh")); err != nil {
		t.Fatal(err)
	}
	if _, err = engine.FinishUpload(ctx, s.ID); err == nil {
		t.Fatal("Missing chunk accepted")
	}
	if _, err = engine.ReceivePart(ctx, s.ID, 0, checksum("abcd"), strings.NewReader("abcd")); err != nil {
		t.Fatal(err)
	}
	if _, err = engine.ReceivePart(ctx, s.ID, 0, checksum("abcd"), strings.NewReader("xxxx")); err == nil {
		t.Fatal("Different body accepted")
	}
	if _, err = engine.FinishUpload(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = engine.FinishUpload(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(filepath.Join(dir, "storage", "files", s.ID))
	if string(content) != "abcdefgh" {
		t.Fatal(string(content))
	}
	if err = engine.CancelUpload(ctx, s.ID); err == nil {
		t.Fatal("Completed file canceled")
	}
}

func newEngine(t *testing.T, size, chunk int64) (*Engine, *Session, string) {
	t.Helper()
	dir := t.TempDir()
	engine := New(Options{AllowAnonymous: true, Sessions: DiskSessions{Directory: filepath.Join(dir, "sessions")}, Storage: DiskStorage{Directory: filepath.Join(dir, "storage")}})
	s, err := engine.CreateUpload(context.Background(), Descriptor{Protocol: "salyra-upload/1", Name: "file.txt", Size: size, ChunkSize: chunk}, "key")
	if err != nil {
		t.Fatal(err)
	}
	return engine, s, dir
}

type outcome struct {
	part Part
	err  error
}

// stalled starts a chunk whose body stops after its first byte until release is called.
func stalled(engine *Engine, id string, index int, text string) (chan outcome, func()) {
	reader, writer := io.Pipe()
	done := make(chan outcome, 1)
	go func() {
		part, err := engine.ReceivePart(context.Background(), id, index, checksum(text), reader)
		done <- outcome{part, err}
	}()
	writer.Write([]byte(text[:1]))
	time.Sleep(200 * time.Millisecond)
	return done, func() { writer.Write([]byte(text[1:])); writer.Close() }
}

func TestChunksArriveSideBySide(t *testing.T) {
	engine, s, _ := newEngine(t, 8, 4)
	ctx := context.Background()
	slow, release := stalled(engine, s.ID, 0, "abcd")
	other := make(chan error, 1)
	go func() {
		_, err := engine.ReceivePart(ctx, s.ID, 1, checksum("efgh"), strings.NewReader("efgh"))
		other <- err
	}()
	select {
	case err := <-other:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("chunk 1 waited for chunk 0 to finish streaming")
	}
	release()
	if result := <-slow; result.err != nil {
		t.Fatal(result.err)
	}
	if _, err := engine.FinishUpload(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
}

func TestSameChunkHasOneWriter(t *testing.T) {
	engine, s, _ := newEngine(t, 4, 4)
	ctx := context.Background()
	slow, release := stalled(engine, s.ID, 0, "abcd")
	twin := make(chan outcome, 1)
	go func() {
		part, err := engine.ReceivePart(ctx, s.ID, 0, checksum("abcd"), strings.NewReader("abcd"))
		twin <- outcome{part, err}
	}()
	select {
	case <-twin:
		t.Fatal("a second request for a streaming chunk did not wait")
	case <-time.After(300 * time.Millisecond):
	}
	release()
	for _, done := range []chan outcome{slow, twin} {
		if result := <-done; result.err != nil || result.part.SHA256 != checksum("abcd") {
			t.Fatal(result.err)
		}
	}
	stored, _ := engine.Options.Sessions.Get(ctx, s.ID)
	if len(stored.Parts) != 1 {
		t.Fatalf("%d parts recorded", len(stored.Parts))
	}
}

func TestCanceledWhileStreamingRefusesTheChunk(t *testing.T) {
	engine, s, _ := newEngine(t, 4, 4)
	ctx := context.Background()
	slow, release := stalled(engine, s.ID, 0, "abcd")
	if err := engine.CancelUpload(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	release()
	if result := <-slow; result.err == nil {
		t.Fatal("a canceled upload took a chunk")
	}
	stored, _ := engine.Options.Sessions.Get(ctx, s.ID)
	if stored.State != "canceled" || len(stored.Parts) != 0 {
		t.Fatalf("%s with %d parts", stored.State, len(stored.Parts))
	}
}

func TestBurstKeepsEveryPartAndRenewsTheExpiry(t *testing.T) {
	const chunks = 32
	engine, s, dir := newEngine(t, chunks*2, 2)
	ctx := context.Background()
	time.Sleep(5 * time.Millisecond)
	var wait sync.WaitGroup
	errs := make(chan error, chunks)
	for i := 0; i < chunks; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			text := string(rune('a'+i%26)) + string(rune('A'+i%26))
			_, err := engine.ReceivePart(ctx, s.ID, i, checksum(text), strings.NewReader(text))
			errs <- err
		}(i)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	// read the record itself: a probe would rebuild it from storage and hide a lost update
	stored, _ := engine.Options.Sessions.Get(ctx, s.ID)
	if len(stored.Parts) != chunks {
		t.Fatalf("%d of %d chunks recorded", len(stored.Parts), chunks)
	}
	for i, part := range stored.Parts {
		if part.Index != i {
			t.Fatalf("part %d is at position %d", part.Index, i)
		}
	}
	if stored.ExpiresAt <= s.ExpiresAt {
		t.Fatal("stored chunks did not extend the expiry")
	}
	if _, err := engine.FinishUpload(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	locks, _ := filepath.Glob(filepath.Join(dir, "sessions", "*-part-*"))
	if len(locks) != 0 {
		t.Fatalf("chunk locks left behind: %v", locks)
	}
}
