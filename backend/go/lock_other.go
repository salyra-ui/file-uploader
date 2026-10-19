//go:build !unix

package upload

import "context"

func lockFile(ctx context.Context, path string) (func(), error) {
	return nil, fail(500, "LOCK_PLATFORM", "Provide a SessionStore with platform-native locking on this platform")
}
