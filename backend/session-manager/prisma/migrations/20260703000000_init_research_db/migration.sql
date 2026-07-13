CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "conditions" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "goal" INTEGER NOT NULL,
  "duration_minutes" INTEGER NOT NULL,
  "group_size" INTEGER NOT NULL,
  "config" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conditions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "condition_id" TEXT NOT NULL,
  "condition_snapshot" JSONB NOT NULL,
  "bot" JSONB NOT NULL,
  "briefing" JSONB NOT NULL,
  "ranking_task" JSONB NOT NULL,
  "ranking" JSONB NOT NULL,
  "polls" JSONB NOT NULL,
  "duration_minutes" INTEGER NOT NULL,
  "room_id" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "participants" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tracking_token" TEXT NOT NULL,
  "matrix_user_id" TEXT,
  "matrix_access_token" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "surveys" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "participant_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "answers" JSONB NOT NULL,
  "submitted_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "timestamp" TIMESTAMPTZ(3) NOT NULL,
  "sender_id" TEXT NOT NULL,
  "recipient_id" TEXT,
  "text" TEXT NOT NULL,
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reactions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "message_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "sender_id" TEXT NOT NULL,
  "timestamp" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "reactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ranking_history" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "session_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "ranking" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ranking_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "interventions" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "room_id" TEXT NOT NULL,
  "condition_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "tone" TEXT NOT NULL,
  "timestamp" TIMESTAMPTZ(3) NOT NULL,
  "trigger" TEXT NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "contribution_window_minutes" INTEGER NOT NULL,
  "message" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  CONSTRAINT "interventions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sessions_condition_id_idx" ON "sessions"("condition_id");
CREATE INDEX "sessions_status_idx" ON "sessions"("status");
CREATE INDEX "sessions_created_at_idx" ON "sessions"("created_at");
CREATE INDEX "participants_session_id_idx" ON "participants"("session_id");
CREATE INDEX "participants_tracking_token_idx" ON "participants"("tracking_token");
CREATE UNIQUE INDEX "surveys_participant_id_kind_key" ON "surveys"("participant_id", "kind");
CREATE INDEX "surveys_kind_idx" ON "surveys"("kind");
CREATE INDEX "messages_session_id_timestamp_idx" ON "messages"("session_id", "timestamp");
CREATE INDEX "reactions_message_id_idx" ON "reactions"("message_id");
CREATE UNIQUE INDEX "ranking_history_session_id_position_key" ON "ranking_history"("session_id", "position");
CREATE INDEX "ranking_history_session_id_idx" ON "ranking_history"("session_id");
CREATE INDEX "interventions_session_id_idx" ON "interventions"("session_id");
CREATE INDEX "interventions_condition_id_idx" ON "interventions"("condition_id");
CREATE INDEX "interventions_timestamp_idx" ON "interventions"("timestamp");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_condition_id_fkey"
  FOREIGN KEY ("condition_id") REFERENCES "conditions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "participants"
  ADD CONSTRAINT "participants_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "surveys"
  ADD CONSTRAINT "surveys_participant_id_fkey"
  FOREIGN KEY ("participant_id") REFERENCES "participants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reactions"
  ADD CONSTRAINT "reactions_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ranking_history"
  ADD CONSTRAINT "ranking_history_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interventions"
  ADD CONSTRAINT "interventions_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
