CREATE FUNCTION "only_students"() RETURNS boolean AS $$ SELECT 'Student only' = 'x' $$ LANGUAGE sql;
CREATE OR REPLACE TRIGGER "t_guard" BEFORE INSERT ON "t" FOR EACH ROW EXECUTE FUNCTION only_students();
DO $$ BEGIN PERFORM 1; END $$;
