CREATE TABLE "stage_archive" AS SELECT "id", "label" FROM "stage" WHERE "archived_at" IS NOT NULL;
CREATE TABLE "kinds" AS SELECT "id", 'soft' AS "kind" FROM "stage";
CREATE TABLE "stage_copy" AS TABLE "stage";
