ALTER TABLE "participants"
  ADD COLUMN "recruitment_source" TEXT NOT NULL DEFAULT 'direct';

UPDATE "participants"
SET "recruitment_source" = 'prolific'
WHERE "prolific_pid" IS NOT NULL
  AND "prolific_study_id" IS NOT NULL
  AND "prolific_session_id" IS NOT NULL;

ALTER TABLE "participants"
  ADD CONSTRAINT "participants_recruitment_source_check"
  CHECK ("recruitment_source" IN ('direct', 'prolific')),
  ADD CONSTRAINT "participants_recruitment_identity_check"
  CHECK (
    (
      "recruitment_source" = 'direct'
      AND "prolific_pid" IS NULL
      AND "prolific_study_id" IS NULL
      AND "prolific_session_id" IS NULL
    )
    OR
    (
      "recruitment_source" = 'prolific'
      AND "prolific_pid" IS NOT NULL
      AND "prolific_study_id" IS NOT NULL
      AND "prolific_session_id" IS NOT NULL
    )
  );

CREATE INDEX "participants_recruitment_source_idx"
  ON "participants"("recruitment_source");
