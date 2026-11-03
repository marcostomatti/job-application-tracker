CREATE TABLE "t" (
  "a" numeric,
  "b" numeric,
  "total" numeric GENERATED ALWAYS AS ("a" + "b") STORED,
  "trend" text GENERATED ALWAYS AS (CASE WHEN "a" > 0 THEN 'up' ELSE 'flat' END) STORED
);
