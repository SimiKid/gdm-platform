ALTER TABLE "sessions"
  ADD COLUMN "waiting_deadline_at" TIMESTAMP(3);

-- Existing open lobbies predate the durable deadline column. Give them the
-- same default window as new lobbies so they cannot remain open forever.
UPDATE "sessions"
SET "waiting_deadline_at" = "created_at" + INTERVAL '15 minutes'
WHERE "status" IN ('waiting', 'provisioning')
  AND "waiting_deadline_at" IS NULL;

ALTER TABLE "prolific_arrivals"
  ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'arrived',
  ADD COLUMN "stage_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "outcome" TEXT,
  ADD COLUMN "outcome_reason" TEXT,
  ADD COLUMN "ended_at" TIMESTAMP(3),
  ADD COLUMN "elapsed_seconds" INTEGER,
  ADD COLUMN "compensation_kind" TEXT,
  ADD COLUMN "compensation_amount_pence" INTEGER;

CREATE INDEX "prolific_arrivals_stage_idx" ON "prolific_arrivals"("stage");
CREATE INDEX "prolific_arrivals_outcome_idx" ON "prolific_arrivals"("outcome");
CREATE INDEX "prolific_arrivals_outcome_last_seen_at_idx"
  ON "prolific_arrivals"("outcome", "last_seen_at");

CREATE TABLE "participation_events" (
  "id" TEXT NOT NULL,
  "prolific_arrival_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "participation_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "participation_events_prolific_arrival_id_fkey"
    FOREIGN KEY ("prolific_arrival_id") REFERENCES "prolific_arrivals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "participation_events_prolific_arrival_id_occurred_at_idx"
  ON "participation_events"("prolific_arrival_id", "occurred_at");

CREATE TABLE "prolific_compensations" (
  "id" TEXT NOT NULL,
  "prolific_arrival_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amount_pence" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'GBP',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "return_requested_at" TIMESTAMP(3),
  "bonus_batch_id" TEXT,
  "payment_submitted_at" TIMESTAMP(3),
  "action_error" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prolific_compensations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prolific_compensations_prolific_arrival_id_fkey"
    FOREIGN KEY ("prolific_arrival_id") REFERENCES "prolific_arrivals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "prolific_compensations_prolific_arrival_id_key"
  ON "prolific_compensations"("prolific_arrival_id");
CREATE INDEX "prolific_compensations_status_next_attempt_at_idx"
  ON "prolific_compensations"("status", "next_attempt_at");
