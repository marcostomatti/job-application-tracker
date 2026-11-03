CREATE TABLE "t" ("id" integer);
COMMENT ON TABLE "t" IS $$a DEFAULT 'x', CHECK ('Icelandic'), CREATE FUNCTION f, ENUM ('Onsite')$$;
COMMENT ON TABLE "t" IS $c1$a DEFAULT 'Icelandic'$c1$;
COMMENT ON TABLE "t" IS $é$a CHECK ('Icelandic')$é$;
