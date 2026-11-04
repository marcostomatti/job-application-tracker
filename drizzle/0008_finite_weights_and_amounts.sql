ALTER TABLE "requirement" DROP CONSTRAINT "requirement_weight_check";--> statement-breakpoint
ALTER TABLE "position_penalty" DROP CONSTRAINT "position_penalty_amount_check";--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_weight_check" CHECK ("requirement"."weight" >= 0 AND "requirement"."weight" < 'Infinity');--> statement-breakpoint
ALTER TABLE "position_penalty" ADD CONSTRAINT "position_penalty_amount_check" CHECK ("position_penalty"."amount" <= 0 AND "position_penalty"."amount" > '-Infinity');