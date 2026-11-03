CREATE TABLE "artefact" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "artefact_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"artefact_kind_id" integer,
	"label" text NOT NULL,
	"locator" text NOT NULL,
	"access_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "company_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"name_unresolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_name_norm_unique" UNIQUE("name_norm")
);
--> statement-breakpoint
CREATE TABLE "position" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "position_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"position_key" text NOT NULL,
	"company_id" integer NOT NULL,
	"role_title" text NOT NULL,
	"role_norm" text NOT NULL,
	"disambiguator" text DEFAULT '' NOT NULL,
	"seen_at" date DEFAULT CURRENT_DATE NOT NULL,
	"deadline" date,
	"city" text,
	"country" text,
	"work_format_id" integer,
	"seniority_id" integer,
	"apply_route_id" integer,
	"salary_raw" text,
	"posting_age_raw" text,
	"applicant_count_raw" text,
	"apply_contact" text,
	"priority_rank" integer,
	"client_hidden" boolean DEFAULT false NOT NULL,
	"first_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_position_key_unique" UNIQUE("position_key"),
	CONSTRAINT "position_company_role_disambiguator_unique" UNIQUE("company_id","role_norm","disambiguator")
);
--> statement-breakpoint
CREATE TABLE "position_summary" (
	"position_id" integer PRIMARY KEY NOT NULL,
	"stack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"industry" text,
	"condensed" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"summarised_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artefact" ADD CONSTRAINT "artefact_artefact_kind_id_artefact_kind_id_fk" FOREIGN KEY ("artefact_kind_id") REFERENCES "public"."artefact_kind"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_work_format_id_work_format_id_fk" FOREIGN KEY ("work_format_id") REFERENCES "public"."work_format"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_seniority_id_seniority_id_fk" FOREIGN KEY ("seniority_id") REFERENCES "public"."seniority"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_apply_route_id_apply_route_id_fk" FOREIGN KEY ("apply_route_id") REFERENCES "public"."apply_route"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_summary" ADD CONSTRAINT "position_summary_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "criteria_set_single_default" ON "criteria_set" USING btree ("is_default") WHERE "criteria_set"."is_default" AND "criteria_set"."archived_at" IS NULL;