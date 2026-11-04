CREATE TABLE "t" ("id" integer);
COMMENT ON TABLE "t" IS $$a DEFAULT 'x', CHECK ('Onsite'), CREATE FUNCTION f, ENUM ('Onsite')$$;
COMMENT ON TABLE "t" IS $c1$a DEFAULT 'Onsite'$c1$;
COMMENT ON TABLE "t" IS $é$a CHECK ('Onsite')$é$;
