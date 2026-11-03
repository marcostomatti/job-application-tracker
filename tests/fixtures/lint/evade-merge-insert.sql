MERGE INTO "t" USING "s" ON "t"."id" = "s"."id"
  WHEN NOT MATCHED THEN INSERT ("id") VALUES (1);
