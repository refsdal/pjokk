package jobs

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

// Photo backup (issue #48). The nightly row dump carries a milestone
// photo's row — its object key, its size — but not its bytes, and the bytes
// are the one thing a family would cry about losing. So the nightly job
// also keeps a copy of every stored photo object, under a prefix of its own:
//
//	photo-backups/current/<key>          one copy per live photo, made once
//	photo-backups/deleted/<date>/<key>   moved here the night after the
//	                                     photo was deleted; pruned after the
//	                                     same 30 days the row dump keeps
//
// A copy per object rather than a copy per night: photos do not change, so
// a dated tree would be 30 copies of the same bytes. "Deleted" copies live
// on for backupRetentionDays from the night the deletion was noticed, which
// is the same promise the privacy policy makes for rows — and no longer,
// because that promise is also an erasure promise.
//
// Its own prefix, not "backups/": PruneBackups deletes anything under
// "backups/" older than 30 days by upload time, which would eat the
// current copies of every photo older than a month.

const (
	photoSourcePrefix  = "milestone-photos/"
	photoCurrentPrefix = "photo-backups/current/"
	photoDeletedPrefix = "photo-backups/deleted/"

	// Exported for the console's backup list, which counts both trees.
	PhotoBackupCurrentPrefix = photoCurrentPrefix
	PhotoBackupDeletedPrefix = photoDeletedPrefix
)

var photoDeletedPattern = regexp.MustCompile(`^photo-backups/deleted/(\d{4}-\d{2}-\d{2})/`)

// RunPhotoBackup copies every photo object that has no current copy yet,
// moves the copies of since-deleted photos into a dated "deleted" tree, and
// prunes "deleted" trees older than backupRetentionDays. Returns (copied,
// moved, pruned).
func RunPhotoBackup(ctx context.Context, d Deps, now time.Time) (int, int, int, error) {
	source, err := d.Storage.List(ctx, photoSourcePrefix)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("jobs: list photos: %w", err)
	}
	live := make(map[string]bool, len(source))
	for _, o := range source {
		live[strings.TrimPrefix(o.Key, photoSourcePrefix)] = true
	}

	current, err := d.Storage.List(ctx, photoCurrentPrefix)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("jobs: list photo backups: %w", err)
	}
	copied := make(map[string]bool, len(current))
	for _, o := range current {
		copied[strings.TrimPrefix(o.Key, photoCurrentPrefix)] = true
	}

	// 1. New photos get a copy.
	nCopied := 0
	for key := range live {
		if copied[key] {
			continue
		}
		if err := copyObject(ctx, d, photoSourcePrefix+key, photoCurrentPrefix+key); err != nil {
			return nCopied, 0, 0, err
		}
		nCopied++
	}

	// 2. Copies of deleted photos move to tonight's dated tree.
	day := now.UTC().Format("2006-01-02")
	nMoved := 0
	for key := range copied {
		if live[key] {
			continue
		}
		if err := copyObject(ctx, d, photoCurrentPrefix+key, photoDeletedPrefix+day+"/"+key); err != nil {
			return nCopied, nMoved, 0, err
		}
		if err := d.Storage.Delete(ctx, photoCurrentPrefix+key); err != nil {
			return nCopied, nMoved, 0, fmt.Errorf("jobs: drop moved photo copy %s: %w", key, err)
		}
		nMoved++
	}

	// 3. Dated trees past the retention window go.
	cutoff := now.Add(-backupRetentionDays * 24 * time.Hour)
	deleted, err := d.Storage.List(ctx, photoDeletedPrefix)
	if err != nil {
		return nCopied, nMoved, 0, fmt.Errorf("jobs: list deleted photo backups: %w", err)
	}
	var stale []string
	for _, o := range deleted {
		m := photoDeletedPattern.FindStringSubmatch(o.Key)
		if m == nil {
			continue
		}
		t, err := time.Parse("2006-01-02", m[1])
		if err != nil {
			continue
		}
		if t.Before(cutoff) {
			stale = append(stale, o.Key)
		}
	}
	if len(stale) > 0 {
		if err := d.Storage.Delete(ctx, stale...); err != nil {
			return nCopied, nMoved, 0, fmt.Errorf("jobs: prune deleted photo backups: %w", err)
		}
	}
	return nCopied, nMoved, len(stale), nil
}

// copyObject is GetStream + Put: the storage port has no copy, and a photo
// is a few hundred kilobytes, so buffering one at a time is fine.
func copyObject(ctx context.Context, d Deps, from, to string) error {
	rc, found, err := d.Storage.GetStream(ctx, from)
	if err != nil {
		return fmt.Errorf("jobs: read %s: %w", from, err)
	}
	if !found {
		return nil // raced with a delete; next night sorts it out
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(rc)
	if err != nil {
		return fmt.Errorf("jobs: read %s: %w", from, err)
	}
	if err := d.Storage.Put(ctx, to, bytes.NewReader(data), int64(len(data)), "image/jpeg"); err != nil {
		return fmt.Errorf("jobs: write %s: %w", to, err)
	}
	return nil
}
