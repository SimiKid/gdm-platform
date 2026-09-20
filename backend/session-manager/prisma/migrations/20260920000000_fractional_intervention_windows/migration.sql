-- Short contribution windows are fractional minutes (for example, 10s = 1/6).
ALTER TABLE "interventions"
  ALTER COLUMN "contribution_window_minutes" TYPE DOUBLE PRECISION;

-- The full JSON payload retained the original value even when the integer
-- column truncated it. Restore that precision without changing research events.
UPDATE "interventions"
SET "contribution_window_minutes" = ("payload"->>'contributionWindowMinutes')::DOUBLE PRECISION
WHERE jsonb_typeof("payload"->'contributionWindowMinutes') = 'number';
