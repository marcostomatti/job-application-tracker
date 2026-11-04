CREATE TABLE "t" ("a" numeric);
COMMENT ON TABLE "t" IS $$holds one application per row$$;
COMMENT ON COLUMN "t"."a" IS 'the coverage score';
