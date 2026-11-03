CREATE TABLE "t" (
  "k" text DEFAULT $$soft$$,
  "n" text DEFAULT $$$$,
  "m" text CHECK ("m" IN ($$gate$$, $$soft$$))
);
CREATE TABLE "u" ("a" text DEFAULT $a1$soft$a1$, "b" text CHECK ("b" IN ($t2$gate$t2$)));
