ALTER TABLE "bounties_cache" ADD COLUMN IF NOT EXISTS "bounty_id" text;
ALTER TABLE "bounties_cache" ADD COLUMN IF NOT EXISTS "currency" text;
ALTER TABLE "bounties_cache" ADD COLUMN IF NOT EXISTS "rail" text;
ALTER TABLE "bounties_cache" ADD COLUMN IF NOT EXISTS "agent_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "hire_agent_id" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "hire_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bounty_id" text NOT NULL,
	"task_id" text NOT NULL,
	"company_id" text NOT NULL,
	"department_id" text NOT NULL,
	"hiring_role" text NOT NULL,
	"hiring_agent" text,
	"hired_agent_id" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"currency" text NOT NULL,
	"rail" text NOT NULL,
	"pay_to" text NOT NULL,
	"quote_hash" text NOT NULL,
	"alignment_score" real,
	"rating_used" real,
	"status" text DEFAULT 'quoted' NOT NULL,
	"deliverable" jsonb,
	"hiring_verdict" text,
	"hiring_reasons" jsonb,
	"log_hash" text,
	"near_tx" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hires_bounty_id_unique" UNIQUE("bounty_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hires_task_idx" ON "hires" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hires_dept_idx" ON "hires" USING btree ("department_id","status");
