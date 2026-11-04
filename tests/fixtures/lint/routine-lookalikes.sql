CREATE TABLE "t" ("id" integer PRIMARY KEY, "trigger_at" timestamp with time zone);
COMMENT ON TABLE "t" IS 'we never CREATE FUNCTION here';
CREATE VIEW "v1" AS SELECT 1 AS "n";
CREATE OR REPLACE VIEW "v2" AS SELECT 2 AS "n";
