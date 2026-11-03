CREATE VIEW "pending" AS SELECT "id" FROM "t" WHERE "kind" = 'gate';
CREATE OR REPLACE VIEW "first_touch" AS
  WITH ranked AS (
    SELECT "id", "lead_id", "touched_on" FROM "t"
  )
  SELECT DISTINCT ON ("lead_id") "lead_id", "touched_on" AS "first_on"
  FROM "ranked" r
  WHERE NOT EXISTS (
    SELECT 1 FROM "t" x
    WHERE x."lead_id" = r."lead_id" AND x."touched_on" < r."touched_on"
  );
