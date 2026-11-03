CREATE TABLE "t" (
  "id" integer PRIMARY KEY,
  "label" text DEFAULT 'Icelandic' NOT NULL,
  "kind" text DEFAULT 'soft' NOT NULL
);
ALTER TABLE "t" ADD COLUMN "mode" text DEFAULT 'Hybrid';
