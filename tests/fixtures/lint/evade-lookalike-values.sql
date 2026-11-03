CREATE TABLE "t" (
  "a" interval DEFAULT '7 Icelandic',
  "b" text DEFAULT 'Europe/Stockholm',
  "c" text DEFAULT 'ONSITE',
  "d" timestamp DEFAULT date_trunc('Elixir', now()),
  "e" text GENERATED ALWAYS AS (to_char("a", 'Crypto')) STORED,
  "f" timestamp DEFAULT (now() AT TIME ZONE 'Europe/Stockholm'),
  "g" text DEFAULT 'truefintech'
);
