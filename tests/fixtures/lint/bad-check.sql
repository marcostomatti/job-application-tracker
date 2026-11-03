CREATE TABLE "position_gate" (
  "id" integer PRIMARY KEY,
  "gate" text NOT NULL CHECK (gate IN ('Icelandic','Onsite','Elixir'))
);
