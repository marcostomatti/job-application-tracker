ALTER TABLE "t" ALTER COLUMN "k" SET DATA TYPE text USING CASE WHEN "k" = 'a' THEN 'Icelandic' ELSE 'soft' END;
ALTER TABLE "t" ALTER COLUMN "k" TYPE text USING (CASE WHEN "k" = 'b' THEN 'Elixir' ELSE 'soft' END);
