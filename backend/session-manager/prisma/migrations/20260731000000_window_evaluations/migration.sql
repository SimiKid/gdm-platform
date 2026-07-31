ALTER TABLE "sessions"
  ADD COLUMN "classification_failures" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE "window_evaluations" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "condition_id" TEXT NOT NULL,
  "arm" TEXT NOT NULL,
  "window_index" INTEGER NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "window_end" TIMESTAMPTZ(3) NOT NULL,
  "outcome" TEXT NOT NULL,
  "llm_mode" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  CONSTRAINT "window_evaluations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "window_evaluations_session_id_idx" ON "window_evaluations"("session_id");
CREATE INDEX "window_evaluations_condition_id_idx" ON "window_evaluations"("condition_id");
CREATE INDEX "window_evaluations_outcome_idx" ON "window_evaluations"("outcome");

ALTER TABLE "window_evaluations"
  ADD CONSTRAINT "window_evaluations_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
