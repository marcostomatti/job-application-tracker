CREATE TABLE "t" ("label" text, "kind" text, "archived_at" timestamp with time zone);
CREATE UNIQUE INDEX "t_label_idx" ON "t" ("label") WHERE "archived_at" IS NULL;
CREATE INDEX "t_kind_idx" ON "t" ("kind") WHERE "kind" = 'gate';
