CREATE TABLE "t" ("a" text, "b" text DEFAULT E'Icelandic\'s');
COMMENT ON TABLE "t" IS E'it\'s a \'table';
INSERT INTO stage (key) VALUES (1);
