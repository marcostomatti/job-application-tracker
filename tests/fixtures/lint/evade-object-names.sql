CREATE TABLE "icelandic_rules" ("id" integer PRIMARY KEY);
CREATE INDEX "elixir_idx" ON "icelandic_rules" ("id");
CREATE TYPE "public"."crypto_kind" AS ENUM('gate');
ALTER TABLE "icelandic_rules" ADD CONSTRAINT "elixir_only_check" CHECK ("id" > 0);
ALTER TABLE "icelandic_rules" RENAME TO "fintech_rules";
