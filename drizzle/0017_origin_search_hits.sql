ALTER TABLE "origin" ADD COLUMN "rank" integer;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "was_new" boolean;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "title_triage" text;--> statement-breakpoint
CREATE UNIQUE INDEX "origin_search_run_posting_idx" ON "origin" USING btree ("search_run_id","posting_id") WHERE "origin"."search_run_id" IS NOT NULL AND "origin"."posting_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_rank_check" CHECK ("origin"."rank" >= 1);--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_title_triage_check" CHECK ("origin"."title_triage" IN ('score', 'skip_title'));--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_search_hit_needs_run_check" CHECK ("origin"."search_run_id" IS NOT NULL OR ("origin"."rank" IS NULL AND "origin"."was_new" IS NULL AND "origin"."title_triage" IS NULL));