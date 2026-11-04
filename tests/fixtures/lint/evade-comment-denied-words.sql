-- Icelandic is a hard gate for every role here; Elixir disqualifies outright.
CREATE TABLE "t" ("id" integer PRIMARY KEY);
COMMENT ON COLUMN "t"."id" IS 'raise the weight for fintech roles';
/* wrapped: the penalty
 * for Crypto firms */
