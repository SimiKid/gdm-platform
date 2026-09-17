-- The study design is narrowed to delivery only: baseline / public-llm /
-- private-llm. The rule-based-only detection arms existed for internal
-- testing, and the two-bot comparison mode (window_evaluations.arm = a/b)
-- is retired with them. Their test sessions cascade to every child table.
DELETE FROM "sessions" WHERE "condition_id" IN ('public-rule', 'private-rule');
DELETE FROM "conditions" WHERE "id" IN ('public-rule', 'private-rule');
ALTER TABLE "window_evaluations" DROP COLUMN "arm";
