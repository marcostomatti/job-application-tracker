CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescore_request" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rescore_request_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"criteria_set_id" integer NOT NULL,
	"since_date" date NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rescore_request" ADD CONSTRAINT "rescore_request_criteria_set_id_criteria_set_id_fk" FOREIGN KEY ("criteria_set_id") REFERENCES "public"."criteria_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "public"."pending_rescore" AS (select "rescore_request"."id" as "rescore_request_id", "position"."id" as "position_id" from "rescore_request" inner join "position" on "position"."seen_at" >= "rescore_request"."since_date" where not exists (
        select 1 from "position_score"
        where ("position_score"."position_id" = "position"."id" and "position_score"."criteria_set_id" = "rescore_request"."criteria_set_id")
      ));