ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "login_method" text;
--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "company_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "title" text;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "launch_company_id" text;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "launched_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Plans that already belong to a company count as launched.
UPDATE "plans" SET "launched_at" = "created_at" WHERE "company_id" IS NOT NULL AND "launched_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plans_created_by_idx" ON "plans" ("created_by", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plans_company_idx" ON "plans" ("company_id");
--> statement-breakpoint
ALTER TABLE "account_emails" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "account_emails" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
ALTER TABLE "account_emails" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_verifications" (
	"account" text PRIMARY KEY NOT NULL,
	"email_ciphertext" text NOT NULL,
	"email_hash" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_prefs" (
	"account" text PRIMARY KEY NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"plan_id" uuid,
	"company_id" text NOT NULL,
	"department_id" text,
	"title" text NOT NULL,
	"tag" text NOT NULL,
	"outcome" text NOT NULL,
	"agent" text,
	"summary" text,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost" numeric(38, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_reports_task_attempt_uq" ON "task_reports" ("task_id", "attempt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_reports_company_idx" ON "task_reports" ("company_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_reports_dept_idx" ON "task_reports" ("department_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_reads" (
	"account" text NOT NULL,
	"item_id" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_reads_account_item_id_pk" PRIMARY KEY("account","item_id")
);
