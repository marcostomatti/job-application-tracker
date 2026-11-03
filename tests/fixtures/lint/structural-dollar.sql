CREATE TABLE "t" (
  "k" text DEFAULT $$soft$$,
  "n" text DEFAULT $$$$,
  "m" text CHECK ("m" IN ($$gate$$, $$soft$$))
);
