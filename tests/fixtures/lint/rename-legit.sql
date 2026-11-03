CREATE TABLE "t" ("a" numeric);
ALTER TABLE "t" RENAME a TO label;
ALTER TABLE "t" RENAME COLUMN label TO title;
ALTER TABLE "t" RENAME TO "t2";
