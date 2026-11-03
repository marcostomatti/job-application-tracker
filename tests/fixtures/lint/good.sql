-- Structural constraints only: closed sets the code defines.
CREATE TABLE "requirement" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "key" text NOT NULL,
  "kind" text NOT NULL,
  "weight" numeric,
  CONSTRAINT "requirement_kind_check" CHECK (kind IN ('gate','soft')),
  CONSTRAINT "requirement_weight_check" CHECK (weight IS NULL OR weight >= 0)
);
--> statement-breakpoint
CREATE TABLE "stage" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "label" text NOT NULL,
  "is_terminal" integer NOT NULL DEFAULT 0 CHECK (is_terminal IN (0,1)),
  "archived_at" timestamptz
);
--> statement-breakpoint
CREATE TYPE "public"."kind" AS ENUM('gate', 'soft');
--> statement-breakpoint
ALTER TYPE "public"."kind" ADD VALUE IF NOT EXISTS 'flat';
