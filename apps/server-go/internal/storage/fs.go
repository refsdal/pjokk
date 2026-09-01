// Filesystem-backed Storage: a self-hoster running the container without a
// bucket at all (STORAGE_DRIVER=fs in internal/config) can point this at a
// mounted volume instead. There is no TypeScript equivalent — apps/api only
// ever spoke S3 — so this driver's contract is defined entirely by the
// Storage interface plus REF §A6, not by porting an existing behaviour.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// tempPrefix marks the temp file Put writes before renaming it into place.
// List skips anything with this prefix so a file mid-write (or, on a crash,
// left behind by an interrupted Put — see fsStorage.Put) never appears as a
// stored object.
const tempPrefix = ".pjokk-tmp-"

type fsStorage struct {
	root string
}

// NewFS builds a filesystem-backed Storage rooted at root. It fails at
// construction — not on the first Put — when root does not exist or is not
// writable, so a misconfigured STORAGE_FS_PATH crash-loops the container on
// boot instead of surfacing as a write failure on the first upload.
func NewFS(root string) (Storage, error) {
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("storage: fs root %q: %w", root, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("storage: fs root %q is not a directory", root)
	}

	probe, err := os.CreateTemp(root, tempPrefix+"probe-*")
	if err != nil {
		return nil, fmt.Errorf("storage: fs root %q is not writable: %w", root, err)
	}
	name := probe.Name()
	probe.Close()
	if err := os.Remove(name); err != nil {
		return nil, fmt.Errorf("storage: fs root %q: remove write probe: %w", root, err)
	}

	return &fsStorage{root: root}, nil
}

// resolve turns a storage key into an on-disk path under root, rejecting any
// key that would escape it. Keys are '/'-separated regardless of host OS
// (matching S3 key semantics); a leading '/' or a ".." segment is rejected
// rather than silently cleaned, since silently cleaning a traversal attempt
// is how you end up serving the wrong file.
func resolve(root, key string) (string, error) {
	if key == "" {
		return "", errors.New("storage: key must not be empty")
	}
	if strings.HasPrefix(key, "/") {
		return "", fmt.Errorf("storage: key %q must not start with /", key)
	}
	clean := path.Clean(key)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("storage: key %q must not escape the storage root", key)
	}

	full := filepath.Join(root, filepath.FromSlash(clean))
	// Belt-and-braces re-check with the OS path rules, in case a future key
	// shape slips past the '/'-based check above.
	rel, err := filepath.Rel(root, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("storage: key %q must not escape the storage root", key)
	}
	return full, nil
}

// Put writes to a temp file in the SAME directory the final file will live
// in, then os.Rename over the destination. Same filesystem + rename is
// atomic on every OS this runs on, so a reader can only ever observe the old
// content or the complete new content — never a partial write, even if the
// process is killed mid-Put.
func (f *fsStorage) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	full, err := resolve(f.root, key)
	if err != nil {
		return err
	}
	dir := filepath.Dir(full)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("storage: mkdir %q: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return fmt.Errorf("storage: create temp file for %q: %w", key, err)
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	if _, err := io.Copy(tmp, body); err != nil {
		return fmt.Errorf("storage: write %q: %w", key, err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("storage: sync %q: %w", key, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("storage: close temp file for %q: %w", key, err)
	}
	if err := os.Rename(tmpName, full); err != nil {
		return fmt.Errorf("storage: rename %q into place: %w", key, err)
	}
	committed = true
	return nil
}

func (f *fsStorage) GetStream(ctx context.Context, key string) (io.ReadCloser, bool, error) {
	full, err := resolve(f.root, key)
	if err != nil {
		return nil, false, err
	}
	file, err := os.Open(full)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("storage: open %q: %w", key, err)
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, false, fmt.Errorf("storage: stat %q: %w", key, err)
	}
	if info.IsDir() {
		file.Close()
		return nil, false, nil
	}
	return file, true, nil
}

func (f *fsStorage) Delete(ctx context.Context, keys ...string) error {
	for _, key := range keys {
		full, err := resolve(f.root, key)
		if err != nil {
			return err
		}
		if err := os.Remove(full); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("storage: delete %q: %w", key, err)
		}
	}
	return nil
}

func (f *fsStorage) List(ctx context.Context, prefix string) ([]StoredObject, error) {
	var out []StoredObject
	err := filepath.WalkDir(f.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if strings.HasPrefix(d.Name(), tempPrefix) {
			return nil
		}
		rel, err := filepath.Rel(f.root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out = append(out, StoredObject{Key: key, UploadedAt: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("storage: list %q: %w", prefix, err)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

var _ Storage = (*fsStorage)(nil)
