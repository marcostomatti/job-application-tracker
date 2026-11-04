CREATE TABLE "posting_question" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "posting_question_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"posting_id" integer NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_question_posting_question_unique" UNIQUE("posting_id","question"),
	CONSTRAINT "posting_question_answered_check" CHECK (("posting_question"."answer" IS NULL) = ("posting_question"."answered_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "text_asset_posting" (
	"text_asset_id" integer NOT NULL,
	"posting_id" integer NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "text_asset_posting_text_asset_id_posting_id_pk" PRIMARY KEY("text_asset_id","posting_id")
);
--> statement-breakpoint
ALTER TABLE "posting_question" ADD CONSTRAINT "posting_question_posting_id_posting_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."posting"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_asset_posting" ADD CONSTRAINT "text_asset_posting_text_asset_id_text_asset_id_fk" FOREIGN KEY ("text_asset_id") REFERENCES "public"."text_asset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_asset_posting" ADD CONSTRAINT "text_asset_posting_posting_id_posting_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."posting"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "text_asset_posting_posting_idx" ON "text_asset_posting" USING btree ("posting_id");