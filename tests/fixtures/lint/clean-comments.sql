-- Registries ship empty; a user fills them with their own vocabulary.
-- A rating is a number from 0 to 1, and null means not rated yet.
CREATE TABLE "t" ("id" integer PRIMARY KEY);
COMMENT ON TABLE "t" IS 'One row per position. Archive rather than delete.';
