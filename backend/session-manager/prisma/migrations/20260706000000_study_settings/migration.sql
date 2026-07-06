CREATE TABLE "study_settings" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "study_settings_pkey" PRIMARY KEY ("key")
);
