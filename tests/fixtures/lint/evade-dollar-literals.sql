CREATE TABLE "t" (
  "id" integer,
  "a" text DEFAULT $$Icelandic$$,
  "b" text DEFAULT $x$Icelandic$x$,
  "c" text CHECK ("c" IN ($$Icelandic$$)),
  "d" text GENERATED ALWAYS AS ($t$Crypto$t$) STORED
);
CREATE TYPE "public"."k" AS ENUM($$Icelandic$$);
ALTER TYPE "public"."k" ADD VALUE $$Onsite$$;
ALTER TYPE "public"."k" RENAME VALUE 'gate' TO $$Elixir$$;
CREATE INDEX "t_idx" ON "t" ("a") WHERE "a" = $$Elixir$$;
