CREATE TABLE "study_rounds" (
  "id" INTEGER NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(3),
  CONSTRAINT "study_rounds_pkey" PRIMARY KEY ("id")
);

-- Exactly one open round (ended_at IS NULL) at any time.
CREATE UNIQUE INDEX "study_rounds_one_open_idx" ON "study_rounds" ((1)) WHERE "ended_at" IS NULL;

-- Backfill: everything recorded so far belongs to Round 1.
INSERT INTO "study_rounds" ("id", "label", "started_at")
VALUES (1, '', COALESCE((SELECT MIN("created_at") FROM "sessions"), CURRENT_TIMESTAMP));

ALTER TABLE "sessions" ADD COLUMN "round_id" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "sessions_round_id_idx" ON "sessions"("round_id");
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_round_id_fkey"
  FOREIGN KEY ("round_id") REFERENCES "study_rounds"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
