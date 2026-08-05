ALTER TABLE "participants"
  ADD COLUMN "prolific_pid" TEXT,
  ADD COLUMN "prolific_study_id" TEXT,
  ADD COLUMN "prolific_session_id" TEXT,
  ADD COLUMN "completed_at" TIMESTAMP(3);

CREATE INDEX "participants_prolific_pid_idx"
  ON "participants"("prolific_pid");

CREATE UNIQUE INDEX "participants_prolific_study_id_prolific_session_id_key"
  ON "participants"("prolific_study_id", "prolific_session_id");

CREATE TABLE "prolific_arrivals" (
  "id" TEXT NOT NULL,
  "prolific_pid" TEXT NOT NULL,
  "prolific_study_id" TEXT NOT NULL,
  "prolific_session_id" TEXT NOT NULL,
  "participant_record_id" TEXT,
  "arrived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prolific_arrivals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "prolific_arrivals_prolific_pid_idx"
  ON "prolific_arrivals"("prolific_pid");

CREATE UNIQUE INDEX "prolific_arrivals_prolific_study_id_prolific_session_id_key"
  ON "prolific_arrivals"("prolific_study_id", "prolific_session_id");
