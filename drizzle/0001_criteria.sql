CREATE TABLE "criteria_set" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "criteria_set_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"apply_threshold" numeric,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "criteria_set_name_version_unique" UNIQUE("name","version"),
	CONSTRAINT "criteria_set_apply_threshold_check" CHECK ("criteria_set"."apply_threshold" >= 0 AND "criteria_set"."apply_threshold" <= 1)
);
--> statement-breakpoint
CREATE TABLE "detour" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "detour_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"requirement_id" integer NOT NULL,
	"label" text NOT NULL,
	"discount" numeric NOT NULL,
	"cost_amount" numeric,
	"cost_unit" text,
	CONSTRAINT "detour_discount_check" CHECK ("detour"."discount" >= 0 AND "detour"."discount" <= 1)
);
--> statement-breakpoint
CREATE TABLE "requirement" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "requirement_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"criteria_set_id" integer NOT NULL,
	"layer_id" integer,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'soft' NOT NULL,
	"weight" numeric,
	"anchors" jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "requirement_criteria_set_id_key_unique" UNIQUE("criteria_set_id","key"),
	CONSTRAINT "requirement_kind_check" CHECK ("requirement"."kind" IN ('gate', 'soft')),
	CONSTRAINT "requirement_weight_check" CHECK ("requirement"."weight" >= 0)
);
--> statement-breakpoint
ALTER TABLE "detour" ADD CONSTRAINT "detour_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_criteria_set_id_criteria_set_id_fk" FOREIGN KEY ("criteria_set_id") REFERENCES "public"."criteria_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_layer_id_layer_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."layer"("id") ON DELETE no action ON UPDATE no action;