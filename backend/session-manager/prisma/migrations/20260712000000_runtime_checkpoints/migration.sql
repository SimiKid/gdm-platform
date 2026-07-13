ALTER TABLE "sessions"
  ADD COLUMN "behavioral_events" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "contribution_classifications" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "processed_event_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "runtime_state" JSONB NOT NULL DEFAULT '{}'::jsonb;
