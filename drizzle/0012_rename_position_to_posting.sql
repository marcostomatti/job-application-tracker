-- Rename the applied-to entity from position to posting (decided 2026-11-04).
-- Pure renames: no table, column, constraint or row is created or dropped,
-- so existing data is kept as it is.
ALTER TABLE "position" RENAME TO "posting";
--> statement-breakpoint
ALTER TABLE "position_disposition" RENAME TO "posting_disposition";
--> statement-breakpoint
ALTER TABLE "position_penalty" RENAME TO "posting_penalty";
--> statement-breakpoint
ALTER TABLE "position_rating" RENAME TO "posting_rating";
--> statement-breakpoint
ALTER TABLE "position_rating_detour" RENAME TO "posting_rating_detour";
--> statement-breakpoint
ALTER TABLE "position_score" RENAME TO "posting_score";
--> statement-breakpoint
ALTER TABLE "position_stage_event" RENAME TO "posting_stage_event";
--> statement-breakpoint
ALTER TABLE "position_summary" RENAME TO "posting_summary";
--> statement-breakpoint
ALTER VIEW "position_first_touch" RENAME TO "posting_first_touch";
--> statement-breakpoint
ALTER TABLE "origin" RENAME COLUMN "position_id" TO "posting_id";
--> statement-breakpoint
ALTER VIEW "pending_rescore" RENAME COLUMN "position_id" TO "posting_id";
--> statement-breakpoint
ALTER TABLE "posting" RENAME COLUMN "position_key" TO "posting_key";
--> statement-breakpoint
ALTER TABLE "posting_disposition" RENAME COLUMN "position_id" TO "posting_id";
--> statement-breakpoint
ALTER VIEW "posting_first_touch" RENAME COLUMN "position_id" TO "posting_id";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME COLUMN "position_id" TO "posting_id";
--> statement-breakpoint
ALTER TABLE "posting_stage_event" RENAME COLUMN "position_id" TO "posting_id";
--> statement-breakpoint
ALTER TABLE "posting_summary" RENAME COLUMN "position_id" TO "posting_id";
--> statement-breakpoint
ALTER TABLE "posting" RENAME CONSTRAINT "position_apply_route_id_apply_route_id_fk" TO "posting_apply_route_id_apply_route_id_fk";
--> statement-breakpoint
ALTER TABLE "posting" RENAME CONSTRAINT "position_company_id_company_id_fk" TO "posting_company_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "posting" RENAME CONSTRAINT "position_company_role_disambiguator_unique" TO "posting_company_role_disambiguator_unique";
--> statement-breakpoint
ALTER TABLE "posting" RENAME CONSTRAINT "position_pkey" TO "posting_pkey";
--> statement-breakpoint
ALTER TABLE "posting" RENAME CONSTRAINT "position_position_key_unique" TO "posting_posting_key_unique";
--> statement-breakpoint
ALTER TABLE "posting" RENAME CONSTRAINT "position_seniority_id_seniority_id_fk" TO "posting_seniority_id_seniority_id_fk";
--> statement-breakpoint
ALTER TABLE "posting" RENAME CONSTRAINT "position_work_format_id_work_format_id_fk" TO "posting_work_format_id_work_format_id_fk";
--> statement-breakpoint
ALTER TABLE "origin" RENAME CONSTRAINT "origin_position_id_position_id_fk" TO "origin_posting_id_posting_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_disposition" RENAME CONSTRAINT "position_disposition_kind_reason_check" TO "posting_disposition_kind_reason_check";
--> statement-breakpoint
ALTER TABLE "posting_disposition" RENAME CONSTRAINT "position_disposition_pkey" TO "posting_disposition_pkey";
--> statement-breakpoint
ALTER TABLE "posting_disposition" RENAME CONSTRAINT "position_disposition_position_id_position_id_fk" TO "posting_disposition_posting_id_posting_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_disposition" RENAME CONSTRAINT "position_disposition_rejection_reason_id_rejection_reason_id_fk" TO "posting_disposition_rejection_reason_id_rejection_reason_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_disposition" RENAME CONSTRAINT "position_disposition_set_aside_reason_id_set_aside_reason_id_fk" TO "posting_disposition_set_aside_reason_id_set_aside_reason_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_penalty" RENAME CONSTRAINT "position_penalty_amount_check" TO "posting_penalty_amount_check";
--> statement-breakpoint
ALTER TABLE "posting_penalty" RENAME CONSTRAINT "position_penalty_penalty_kind_id_penalty_kind_id_fk" TO "posting_penalty_penalty_kind_id_penalty_kind_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_penalty" RENAME CONSTRAINT "position_penalty_pkey" TO "posting_penalty_pkey";
--> statement-breakpoint
ALTER TABLE "posting_penalty" RENAME CONSTRAINT "position_penalty_score_id_position_score_id_fk" TO "posting_penalty_score_id_posting_score_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_penalty" RENAME CONSTRAINT "position_penalty_score_kind_unique" TO "posting_penalty_score_kind_unique";
--> statement-breakpoint
ALTER TABLE "posting_rating_detour" RENAME CONSTRAINT "position_rating_detour_coverage_check" TO "posting_rating_detour_coverage_check";
--> statement-breakpoint
ALTER TABLE "posting_rating_detour" RENAME CONSTRAINT "position_rating_detour_detour_fk" TO "posting_rating_detour_detour_fk";
--> statement-breakpoint
ALTER TABLE "posting_rating_detour" RENAME CONSTRAINT "position_rating_detour_rating_fk" TO "posting_rating_detour_rating_fk";
--> statement-breakpoint
ALTER TABLE "posting_rating_detour" RENAME CONSTRAINT "position_rating_detour_score_id_detour_id_pk" TO "posting_rating_detour_score_id_detour_id_pk";
--> statement-breakpoint
ALTER TABLE "posting_rating" RENAME CONSTRAINT "position_rating_confidence_check" TO "posting_rating_confidence_check";
--> statement-breakpoint
ALTER TABLE "posting_rating" RENAME CONSTRAINT "position_rating_coverage_check" TO "posting_rating_coverage_check";
--> statement-breakpoint
ALTER TABLE "posting_rating" RENAME CONSTRAINT "position_rating_score_id_requirement_id_pk" TO "posting_rating_score_id_requirement_id_pk";
--> statement-breakpoint
ALTER TABLE "posting_rating" RENAME CONSTRAINT "position_rating_score_set_fk" TO "posting_rating_score_set_fk";
--> statement-breakpoint
ALTER TABLE "posting_rating" RENAME CONSTRAINT "position_rating_set_requirement_fk" TO "posting_rating_set_requirement_fk";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_ceiling_check" TO "posting_score_ceiling_check";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_criteria_set_id_criteria_set_id_fk" TO "posting_score_criteria_set_id_criteria_set_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_floor_check" TO "posting_score_floor_check";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_id_criteria_set_unique" TO "posting_score_id_criteria_set_unique";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_limiter_coverage_check" TO "posting_score_limiter_coverage_check";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_limiter_set_fk" TO "posting_score_limiter_set_fk";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_overall_check" TO "posting_score_overall_check";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_pkey" TO "posting_score_pkey";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_position_id_position_id_fk" TO "posting_score_posting_id_posting_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_position_set_day_unique" TO "posting_score_posting_set_day_unique";
--> statement-breakpoint
ALTER TABLE "posting_score" RENAME CONSTRAINT "position_score_runner_up_set_fk" TO "posting_score_runner_up_set_fk";
--> statement-breakpoint
ALTER TABLE "posting_stage_event" RENAME CONSTRAINT "position_stage_event_pkey" TO "posting_stage_event_pkey";
--> statement-breakpoint
ALTER TABLE "posting_stage_event" RENAME CONSTRAINT "position_stage_event_position_id_position_id_fk" TO "posting_stage_event_posting_id_posting_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_stage_event" RENAME CONSTRAINT "position_stage_event_stage_id_stage_id_fk" TO "posting_stage_event_stage_id_stage_id_fk";
--> statement-breakpoint
ALTER TABLE "posting_summary" RENAME CONSTRAINT "position_summary_pkey" TO "posting_summary_pkey";
--> statement-breakpoint
ALTER TABLE "posting_summary" RENAME CONSTRAINT "position_summary_position_id_position_id_fk" TO "posting_summary_posting_id_posting_id_fk";
--> statement-breakpoint
ALTER INDEX "origin_position_touch_idx" RENAME TO "origin_posting_touch_idx";
--> statement-breakpoint
ALTER INDEX "position_disposition_position_idx" RENAME TO "posting_disposition_posting_idx";
--> statement-breakpoint
ALTER INDEX "position_stage_event_position_time_idx" RENAME TO "posting_stage_event_posting_time_idx";
--> statement-breakpoint
ALTER SEQUENCE "position_disposition_id_seq" RENAME TO "posting_disposition_id_seq";
--> statement-breakpoint
ALTER SEQUENCE "position_id_seq" RENAME TO "posting_id_seq";
--> statement-breakpoint
ALTER SEQUENCE "position_penalty_id_seq" RENAME TO "posting_penalty_id_seq";
--> statement-breakpoint
ALTER SEQUENCE "position_score_id_seq" RENAME TO "posting_score_id_seq";
--> statement-breakpoint
ALTER SEQUENCE "position_stage_event_id_seq" RENAME TO "posting_stage_event_id_seq";
