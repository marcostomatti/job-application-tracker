CREATE TABLE "origin" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "origin_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"position_id" integer,
	"route_id" integer,
	"touched_on" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"search_run_id" integer
);
--> statement-breakpoint
CREATE TABLE "search_run" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_run_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"query" text NOT NULL,
	"source" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_route_id_route_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."route"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_search_run_id_search_run_id_fk" FOREIGN KEY ("search_run_id") REFERENCES "public"."search_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "origin_position_touch_idx" ON "origin" USING btree ("position_id","touched_on","recorded_at","id");--> statement-breakpoint
CREATE VIEW "public"."position_first_touch" AS (select distinct on ("origin"."position_id") "position_id", "id" as "origin_id", "route_id", "touched_on" from "origin" where "origin"."position_id" IS NOT NULL AND "origin"."touched_on" <= CURRENT_DATE order by "origin"."position_id", "origin"."touched_on", "origin"."recorded_at", "origin"."id");