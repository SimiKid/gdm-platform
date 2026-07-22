-- The study design was restructured around delivery (public/private) ×
-- detection (rule / rule+LLM); the neutral/engaging tone axis is retired.
ALTER TABLE "interventions" DROP COLUMN "tone";
