CREATE TABLE "t" (
  "id" integer,
  "due_at" timestamp with time zone DEFAULT (now() + interval '7 days'),
  "day" timestamp with time zone DEFAULT date_trunc('day', now()),
  "label" text GENERATED ALWAYS AS (to_char("due_at", 'YYYY-MM-DD')) STORED,
  "utc_at" timestamp DEFAULT (now() AT TIME ZONE 'utc'),
  "ends_at" timestamp with time zone DEFAULT 'infinity',
  "starts_at" timestamp with time zone DEFAULT 'epoch',
  "epsilon" numeric DEFAULT '1e-3',
  "flag" text DEFAULT 'true'
);
