CREATE TABLE "a1" AS (SELECT "id" FROM "stage");
CREATE TABLE "a2" (LIKE "stage");
CREATE TABLE "a3" ("id" integer, "total" integer GENERATED ALWAYS AS ("id" + 1) STORED);
CREATE TABLE "a4" ("id", "label") AS (SELECT "id", "label" FROM "stage");
