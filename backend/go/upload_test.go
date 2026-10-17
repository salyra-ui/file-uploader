package upload

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
