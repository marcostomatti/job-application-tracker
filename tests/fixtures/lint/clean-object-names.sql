CREATE TABLE "requirement" ("id" integer PRIMARY KEY, "key" text);
CREATE UNIQUE INDEX "requirement_key_idx" ON "requirement" ("key");
CREATE TYPE "public"."requirement_kind" AS ENUM('gate', 'soft');
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_key_unique" UNIQUE ("key");
ALTER TABLE "requirement" RENAME TO "requirement_v2";
