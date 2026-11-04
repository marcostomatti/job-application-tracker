CREATE TABLE "t" (
  "id" integer PRIMARY KEY,
  "tag" text GENERATED ALWAYS AS (CASE WHEN true THEN 'Crypto' ELSE 'Onsite' END) STORED
);
