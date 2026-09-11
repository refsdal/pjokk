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
// "Live" means a milestone_photo ROW names the object, not that the object
// is in the store (issue #95). Deleting a family or a baby removes the rows
// and then the objects; if the second half fails — or the object predates
// that fix — the object stays with nothing pointing at it, and reading
// "live" from the store would have kept it, and its copy, forever. The job
// treats such an orphan as a deleted photo: the source object goes, its
// copy moves into tonight's dated tree (made from the source if it never
// had one), and the 30-day prune finishes the erasure.
//
// Its own prefix, not "backups/": PruneBackups deletes anything under
// "backups/" older than 30 days by upload time, which would eat the
// current copies of every photo older than a month.

const (
	photoSourcePrefix  = "milestone-photos/"
	photoCurrentPrefix = "photo-backups/current/"
	photoDeletedPrefix = "photo-backups/deleted/"

	// Exported for the console's backup list, which counts both trees, and
	// for internal/restore, which copies photos back out of them.
	PhotoSourcePrefix        = photoSourcePrefix
	PhotoBackupCurrentPrefix = photoCurrentPrefix
	PhotoBackupDeletedPrefix = photoDeletedPrefix

	// orphanGrace is how old an object with no row must be before the job
	// erases it. The upload route stores the object BEFORE it inserts the
	// row, so a photo mid-upload is briefly exactly that. An hour is far
	// longer than any upload, and nothing against a 30-day window.
	orphanGrace = time.Hour
)

var photoDeletedPattern = regexp.MustCompile(`^photo-backups/deleted/(\d{4}-\d{2}-\d{2})/`)

// PhotoBackupResult counts what one run of RunPhotoBackup did.
type PhotoBackupResult struct {
	Copied   int // live photos given their current copy
	Moved    int // copies put into tonight's deleted tree
	Orphaned int // source objects no photo row names, erased
	Pruned   int // deleted-tree copies past the retention window, erased
}

// RunPhotoBackup copies every live photo that has no current copy yet,
// erases source objects no photo row names, moves the copies of photos
// that are gone into a dated "deleted" tree, and prunes "deleted" trees
// older than backupRetentionDays.
func RunPhotoBackup(ctx context.Context, d Deps, now time.Time) (PhotoBackupResult, error) {
	var res PhotoBackupResult

	// Rows before the store: a photo uploaded in between is an object with
	// no row yet, which orphanGrace protects. The other order could see a
	// row whose object was listed before it was stored — harmless too, but
	// this one needs no second thought.
	rowKeys, err := d.Q.ListMilestonePhotoKeys(ctx)
	if err != nil {
		return res, fmt.Errorf("jobs: list photo rows: %w", err)
	}
	live := make(map[string]bool, len(rowKeys))
	for _, k := range rowKeys {
		if rest, ok := strings.CutPrefix(k, photoSourcePrefix); ok {
			live[rest] = true
		}
	}

	source, err := d.Storage.List(ctx, photoSourcePrefix)
	if err != nil {
		return res, fmt.Errorf("jobs: list photos: %w", err)
	}
	stored := make(map[string]time.Time, len(source))
	for _, o := range source {
		stored[strings.TrimPrefix(o.Key, photoSourcePrefix)] = o.UploadedAt
	}

	current, err := d.Storage.List(ctx, photoCurrentPrefix)
	if err != nil {
		return res, fmt.Errorf("jobs: list photo backups: %w", err)
	}
	copied := make(map[string]bool, len(current))
	for _, o := range current {
		copied[strings.TrimPrefix(o.Key, photoCurrentPrefix)] = true
	}

	day := now.UTC().Format("2006-01-02")

	// 1. Live photos get a copy. A row whose object is missing has nothing
	// to copy.
	for key := range live {
		if _, ok := stored[key]; !ok || copied[key] {
			continue
		}
		if err := copyObject(ctx, d, photoSourcePrefix+key, photoCurrentPrefix+key); err != nil {
			return res, err
		}
		res.Copied++
	}

	// 2. Orphans go. One with a current copy leaves it for step 3 to move;
	// one never backed up is copied straight into tonight's dated tree, so
	// it is restorable for the same 30 days as any deleted photo and no
	// longer.
	for key, uploadedAt := range stored {
		if live[key] || now.Sub(uploadedAt) < orphanGrace {
			continue
		}
		if !copied[key] {
			if err := copyObject(ctx, d, photoSourcePrefix+key, photoDeletedPrefix+day+"/"+key); err != nil {
				return res, err
			}
			res.Moved++
		}
		if err := d.Storage.Delete(ctx, photoSourcePrefix+key); err != nil {
			return res, fmt.Errorf("jobs: erase orphaned photo %s: %w", key, err)
		}
		res.Orphaned++
	}

	// 3. Copies of photos with no row move to tonight's dated tree.
	for key := range copied {
		if live[key] {
			continue
		}
		if err := copyObject(ctx, d, photoCurrentPrefix+key, photoDeletedPrefix+day+"/"+key); err != nil {
			return res, err
		}
		if err := d.Storage.Delete(ctx, photoCurrentPrefix+key); err != nil {
			return res, fmt.Errorf("jobs: drop moved photo copy %s: %w", key, err)
		}
		res.Moved++
	}

	// 4. Dated trees past the retention window go.
	cutoff := now.Add(-backupRetentionDays * 24 * time.Hour)
	deleted, err := d.Storage.List(ctx, photoDeletedPrefix)
	if err != nil {
		return res, fmt.Errorf("jobs: list deleted photo backups: %w", err)
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
			return res, fmt.Errorf("jobs: prune deleted photo backups: %w", err)
		}
	}
	res.Pruned = len(stale)
	return res, nil
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
