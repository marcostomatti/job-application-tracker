CREATE TABLE "apply_route" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "apply_route_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artefact_kind" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "artefact_kind_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "layer" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "layer_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone,
	"key" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "layer_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "penalty_kind" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "penalty_kind_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "phase" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "phase_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone,
	"key" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_shortlist" boolean DEFAULT false NOT NULL,
	CONSTRAINT "phase_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rejection_reason" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rejection_reason_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "route" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "route_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "seniority" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "seniority_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "set_aside_reason" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "set_aside_reason_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stage" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone,
	"key" text NOT NULL,
	"phase_id" integer,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_terminal" boolean DEFAULT false NOT NULL,
	"is_repeatable" boolean DEFAULT false NOT NULL,
	"is_traction" boolean DEFAULT false NOT NULL,
	"is_applied" boolean DEFAULT false NOT NULL,
	CONSTRAINT "stage_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "text_type" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "text_type_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_format" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "work_format_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_phase_id_phase_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phase"("id") ON DELETE no action ON UPDATE no action;