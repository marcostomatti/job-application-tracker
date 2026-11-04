CREATE TABLE "position_rating_detour" (
	"score_id" integer NOT NULL,
	"requirement_id" integer NOT NULL,
	"detour_id" integer NOT NULL,
	"coverage" numeric,
	CONSTRAINT "position_rating_detour_score_id_detour_id_pk" PRIMARY KEY("score_id","detour_id"),
	CONSTRAINT "position_rating_detour_coverage_check" CHECK ("position_rating_detour"."coverage" >= 0 AND "position_rating_detour"."coverage" <= 1)
);
--> statement-breakpoint
ALTER TABLE "detour" ADD CONSTRAINT "detour_requirement_id_id_unique" UNIQUE("requirement_id","id");--> statement-breakpoint
ALTER TABLE "position_rating_detour" ADD CONSTRAINT "position_rating_detour_rating_fk" FOREIGN KEY ("score_id","requirement_id") REFERENCES "public"."position_rating"("score_id","requirement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_rating_detour" ADD CONSTRAINT "position_rating_detour_detour_fk" FOREIGN KEY ("requirement_id","detour_id") REFERENCES "public"."detour"("requirement_id","id") ON DELETE no action ON UPDATE no action;