CREATE TABLE "t2" AS (SELECT 'Icelandic');
CREATE TABLE "t3" AS EXECUTE "prepared"('Elixir');
CREATE TABLE "t4" AS (SELECT 'soft' AS "icelandic_required" FROM "x");
