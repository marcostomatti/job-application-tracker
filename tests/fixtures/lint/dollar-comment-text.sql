CREATE TABLE "t" ("id" integer);
COMMENT ON TABLE "t" IS $$a DEFAULT 'x', CHECK ('Icelandic'), CREATE FUNCTION f, ENUM ('Onsite')$$;
