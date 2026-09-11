package restore

import (
	"context"
	"fmt"
	"strings"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/storage"
)

// photoKeys are the object keys a snapshot's milestone_photo rows name.
func photoKeys(rows []map[string]any) []string {
	var keys []string
	for _, r := range rows {
		if k, ok := r["object_key"].(string); ok && k != "" {
			keys = append(keys, k)
		}
	}
	return keys
}

// restorePhotos puts each photo object back from the photo backup
// (jobs.RunPhotoBackup): the copy under photo-backups/current/, or failing
// that the newest under photo-backups/deleted/<date>/ — a family's photos
// move there the night after it is deleted. An object already in place is
// left alone. A photo with no copy anywhere (uploaded after the last
// photo backup, or pruned) is reported, not fatal: the rest of the restore
// is worth having without it.
func restorePhotos(ctx context.Context, st storage.Storage, keys []string) (restored int, missing []string, err error) {
	if len(keys) == 0 {
		return 0, nil, nil
	}
	live, err := st.List(ctx, jobs.PhotoSourcePrefix)
	if err != nil {
		return 0, nil, fmt.Errorf("restore: list photos: %w", err)
	}
	present := map[string]bool{}
	for _, o := range live {
		present[o.Key] = true
	}

	current, err := st.List(ctx, jobs.PhotoBackupCurrentPrefix)
	if err != nil {
		return 0, nil, fmt.Errorf("restore: list photo copies: %w", err)
	}
	copies := map[string]storage.StoredObject{}
	for _, o := range current {
		copies[strings.TrimPrefix(o.Key, jobs.PhotoBackupCurrentPrefix)] = o
	}

	deleted, err := st.List(ctx, jobs.PhotoBackupDeletedPrefix)
	if err != nil {
		return 0, nil, fmt.Errorf("restore: list deleted photo copies: %w", err)
	}
	// deleted/<YYYY-MM-DD>/<rest>: the newest date wins, and the dates sort
	// as strings.
	newest := map[string]string{}
	older := map[string]storage.StoredObject{}
	for _, o := range deleted {
		date, rest, ok := strings.Cut(strings.TrimPrefix(o.Key, jobs.PhotoBackupDeletedPrefix), "/")
		if !ok {
			continue
		}
		if date > newest[rest] {
			newest[rest] = date
			older[rest] = o
		}
	}

	for _, key := range keys {
		if present[key] {
			continue
		}
		rest, ok := strings.CutPrefix(key, jobs.PhotoSourcePrefix)
		src, found := copies[rest]
		if !found {
			src, found = older[rest]
		}
		if !ok || !found {
			missing = append(missing, key)
			continue
		}
		if err := copyObject(ctx, st, src, key); err != nil {
			return restored, missing, err
		}
		restored++
	}
	return restored, missing, nil
}

func copyObject(ctx context.Context, st storage.Storage, src storage.StoredObject, dst string) error {
	rc, found, err := st.GetStream(ctx, src.Key)
	if err != nil {
		return fmt.Errorf("restore: read %s: %w", src.Key, err)
	}
	if !found {
		return fmt.Errorf("restore: %s vanished while restoring", src.Key)
	}
	defer func() { _ = rc.Close() }()
	if err := st.Put(ctx, dst, rc, src.Size, "image/jpeg"); err != nil {
		return fmt.Errorf("restore: write %s: %w", dst, err)
	}
	return nil
}
