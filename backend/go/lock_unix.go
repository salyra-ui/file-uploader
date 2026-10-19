//go:build unix

package upload

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"
)

func lockFile(ctx context.Context, path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	for {
		if err = ctx.Err(); err != nil {
			file.Close()
			return nil, err
		}
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { syscall.Flock(int(file.Fd()), syscall.LOCK_UN); file.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			file.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}
