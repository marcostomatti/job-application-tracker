CREATE TABLE "position_penalty" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "position_penalty_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"score_id" integer NOT NULL,
	"penalty_kind_id" integer NOT NULL,
	"amount" numeric DEFAULT '0' NOT NULL,
	"reason" text,
	CONSTRAINT "position_penalty_score_kind_unique" UNIQUE("score_id","penalty_kind_id"),
	CONSTRAINT "position_penalty_amount_check" CHECK ("position_penalty"."amount" <= 0)
);
--> statement-breakpoint
CREATE TABLE "position_rating" (
	"score_id" integer NOT NULL,
	"criteria_set_id" integer NOT NULL,
	"requirement_id" integer NOT NULL,
	"coverage" numeric,
	"confidence" text DEFAULT 'unknown' NOT NULL,
	"evidence" text,
	CONSTRAINT "position_rating_score_id_requirement_id_pk" PRIMARY KEY("score_id","requirement_id"),
	CONSTRAINT "position_rating_coverage_check" CHECK ("position_rating"."coverage" >= 0 AND "position_rating"."coverage" <= 1),
	CONSTRAINT "position_rating_confidence_check" CHECK ("position_rating"."confidence" IN ('supported', 'partial', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "position_score" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "position_score_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"position_id" integer NOT NULL,
	"criteria_set_id" integer NOT NULL,
	"scored_at" date DEFAULT CURRENT_DATE NOT NULL,
	"overall" numeric,
	"limiter_requirement_id" integer,
	"limiter_coverage" numeric,
	"limiter_is_unknown" boolean DEFAULT false NOT NULL,
	"runner_up_requirement_id" integer,
	"floor" numeric,
	"ceiling" numeric,
	"recommend_apply" boolean DEFAULT false NOT NULL,
	"is_rescore" boolean DEFAULT false NOT NULL,
	"note" text,
	CONSTRAINT "position_score_position_set_day_unique" UNIQUE("position_id","criteria_set_id","scored_at"),
	CONSTRAINT "position_score_id_criteria_set_unique" UNIQUE("id","criteria_set_id"),
	CONSTRAINT "position_score_overall_check" CHECK ("position_score"."overall" >= 0 AND "position_score"."overall" <= 1),
	CONSTRAINT "position_score_floor_check" CHECK ("position_score"."floor" >= 0 AND "position_score"."floor" <= 1),
	CONSTRAINT "position_score_ceiling_check" CHECK ("position_score"."ceiling" >= 0 AND "position_score"."ceiling" <= 1),
	CONSTRAINT "position_score_limiter_coverage_check" CHECK ("position_score"."limiter_coverage" >= 0 AND "position_score"."limiter_coverage" <= 1)
);
--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_criteria_set_id_id_unique" UNIQUE("criteria_set_id","id");--> statement-breakpoint
ALTER TABLE "position_penalty" ADD CONSTRAINT "position_penalty_score_id_position_score_id_fk" FOREIGN KEY ("score_id") REFERENCES "public"."position_score"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_penalty" ADD CONSTRAINT "position_penalty_penalty_kind_id_penalty_kind_id_fk" FOREIGN KEY ("penalty_kind_id") REFERENCES "public"."penalty_kind"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_rating" ADD CONSTRAINT "position_rating_score_set_fk" FOREIGN KEY ("score_id","criteria_set_id") REFERENCES "public"."position_score"("id","criteria_set_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_rating" ADD CONSTRAINT "position_rating_set_requirement_fk" FOREIGN KEY ("criteria_set_id","requirement_id") REFERENCES "public"."requirement"("criteria_set_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_score" ADD CONSTRAINT "position_score_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_score" ADD CONSTRAINT "position_score_criteria_set_id_criteria_set_id_fk" FOREIGN KEY ("criteria_set_id") REFERENCES "public"."criteria_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_score" ADD CONSTRAINT "position_score_limiter_set_fk" FOREIGN KEY ("criteria_set_id","limiter_requirement_id") REFERENCES "public"."requirement"("criteria_set_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_score" ADD CONSTRAINT "position_score_runner_up_set_fk" FOREIGN KEY ("criteria_set_id","runner_up_requirement_id") REFERENCES "public"."requirement"("criteria_set_id","id") ON DELETE no action ON UPDATE no action;