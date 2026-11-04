CREATE TABLE "position_penalty" (
  "id" integer PRIMARY KEY,
  "amount" numeric NOT NULL,
  "penalty_fintech" numeric,
  "is_proptech_client" boolean
);
