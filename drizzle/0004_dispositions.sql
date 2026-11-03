CREATE TABLE "position_disposition" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "position_disposition_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"position_id" integer NOT NULL,
	"kind" text NOT NULL,
	"set_aside_reason_id" integer,
	"rejection_reason_id" integer,
	"noted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "position_disposition_kind_reason_check" CHECK (("position_disposition"."kind" = 'set_aside' AND "position_disposition"."set_aside_reason_id" IS NOT NULL AND "position_disposition"."rejection_reason_id" IS NULL)
        OR ("position_disposition"."kind" = 'rejected' AND "position_disposition"."rejection_reason_id" IS NOT NULL AND "position_disposition"."set_aside_reason_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "position_stage_event" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "position_stage_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"position_id" integer NOT NULL,
	"stage_id" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "position_disposition" ADD CONSTRAINT "position_disposition_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_disposition" ADD CONSTRAINT "position_disposition_set_aside_reason_id_set_aside_reason_id_fk" FOREIGN KEY ("set_aside_reason_id") REFERENCES "public"."set_aside_reason"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_disposition" ADD CONSTRAINT "position_disposition_rejection_reason_id_rejection_reason_id_fk" FOREIGN KEY ("rejection_reason_id") REFERENCES "public"."rejection_reason"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_stage_event" ADD CONSTRAINT "position_stage_event_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_stage_event" ADD CONSTRAINT "position_stage_event_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "position_disposition_position_idx" ON "position_disposition" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "position_stage_event_position_time_idx" ON "position_stage_event" USING btree ("position_id","occurred_at","id");