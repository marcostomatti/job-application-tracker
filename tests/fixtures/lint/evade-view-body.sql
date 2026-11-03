CREATE VIEW "v" AS SELECT CASE WHEN "a" > 0 THEN 'Hybrid' ELSE 'flat' END AS "x" FROM "t";
