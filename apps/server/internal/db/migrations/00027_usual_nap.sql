-- +goose Up

-- The family's own nap anchor (issue #112). Past twelve months the rhythm
-- is set by a barnehage's fixed midday nap, not by a wake window, and the
-- nap-window guide's cited table stops at twelve months because its source
-- does. "Usual nap 11:30" is the family's number: minutes after LOCAL
-- midnight, a wall-clock time with no timezone, like a reminder's at_minute.
-- Beside the other things the family has written about the child (00025).
ALTER TABLE "baby_about" ADD COLUMN "usual_nap_minute" integer
	CHECK ("usual_nap_minute" BETWEEN 0 AND 1439);

-- +goose Down
ALTER TABLE "baby_about" DROP COLUMN "usual_nap_minute";
