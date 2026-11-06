ALTER TABLE "posting_score" ADD COLUMN "agent_verdict" text;--> statement-breakpoint
ALTER TABLE "posting_score" ADD COLUMN "agent_reason" text;--> statement-breakpoint
ALTER TABLE "posting_score" ADD CONSTRAINT "posting_score_agent_verdict_check" CHECK ("posting_score"."agent_verdict" IN ('apply', 'ask', 'skip'));--> statement-breakpoint
ALTER TABLE "posting_score" ADD CONSTRAINT "posting_score_agent_reason_length_check" CHECK (char_length("posting_score"."agent_reason") <= 500);--> statement-breakpoint
ALTER TABLE "posting_score" ADD CONSTRAINT "posting_score_agent_reason_needs_verdict_check" CHECK ("posting_score"."agent_verdict" IS NOT NULL OR "posting_score"."agent_reason" IS NULL);