-- Reject late checkpoint requests without deleting or regressing newer state.
ALTER TABLE "sessions"
ADD COLUMN "checkpoint_revision" INTEGER NOT NULL DEFAULT 0;
