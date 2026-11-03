ALTER TABLE "t" ALTER COLUMN "n" TYPE integer USING "n"::integer;
ALTER TABLE "t" ALTER COLUMN "m" TYPE integer USING ("m"::text::integer);
ALTER TABLE "t" ALTER COLUMN "k" TYPE text USING CASE WHEN "k" = 'gate' THEN 'soft' ELSE "k" END;
