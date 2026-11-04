CREATE TABLE "text_asset" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "text_asset_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"text_type_id" integer,
	"label" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "text_asset" ADD CONSTRAINT "text_asset_text_type_id_text_type_id_fk" FOREIGN KEY ("text_type_id") REFERENCES "public"."text_type"("id") ON DELETE no action ON UPDATE no action;