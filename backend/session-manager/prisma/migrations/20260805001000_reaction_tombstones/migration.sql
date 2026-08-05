-- Keep reaction events as immutable research rows while allowing a later
-- Matrix redaction (emoji toggle-off) to change the active aggregate.
ALTER TABLE "reactions"
ADD COLUMN "event_id" TEXT,
ADD COLUMN "redacted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "redaction_event_id" TEXT,
ADD COLUMN "redacted_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "reactions_event_id_key" ON "reactions"("event_id");
CREATE INDEX "reactions_message_id_redacted_idx"
ON "reactions"("message_id", "redacted");

DROP INDEX "reactions_message_id_idx";
