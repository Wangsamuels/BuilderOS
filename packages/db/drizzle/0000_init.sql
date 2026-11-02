CREATE TABLE "account_emails" (
	"account" text PRIMARY KEY NOT NULL,
	"email_ciphertext" text NOT NULL,
	"email_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"public_key" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"department_id" text NOT NULL,
	"role" text NOT NULL,
	"max_tier" text,
	"status" text DEFAULT 'active' NOT NULL,
	"block_height" bigint,
	"near_tx" text
);
--> statement-breakpoint
CREATE TABLE "approval_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"day" text,
	"request_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount" numeric(38, 0),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"public_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bounties_cache" (
	"task_id" text PRIMARY KEY NOT NULL,
	"payee" text,
	"amount" numeric(38, 0),
	"status" text NOT NULL,
	"verdict" text,
	"log_hash" text,
	"block_height" bigint,
	"near_tx" text
);
--> statement-breakpoint
CREATE TABLE "bridge_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"department_id" text NOT NULL,
	"direction" text NOT NULL,
	"amount_in" numeric(38, 0),
	"amount_out" numeric(38, 0),
	"fees" numeric(38, 0),
	"quote_id" text,
	"deposit_address" text,
	"origin_tx" text,
	"relay_request_id" text,
	"dest_tx" text,
	"status" text NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_transfers_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text,
	"preset" text,
	"network" text NOT NULL,
	"founder_account" text NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"code_key_version" integer DEFAULT 0 NOT NULL,
	"block_height" bigint,
	"near_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contract" text,
	"raw" text NOT NULL,
	"error" text NOT NULL,
	"block_height" bigint,
	"near_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"account_id" text NOT NULL,
	"name" text,
	"contract_hash" text,
	"base_address" text,
	"frozen" boolean DEFAULT false NOT NULL,
	"block_height" bigint,
	"near_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "encrypted_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" text NOT NULL,
	"task_id" text,
	"key_version" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"hash_on_chain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"standard" text NOT NULL,
	"version" text NOT NULL,
	"contract" text NOT NULL,
	"company_id" text,
	"department_id" text,
	"data" jsonb NOT NULL,
	"receipt_id" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_height" bigint,
	"near_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_block_height" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" text NOT NULL,
	"email_hash" text NOT NULL,
	"email_ciphertext" text,
	"code_hash" text NOT NULL,
	"departments" jsonb NOT NULL,
	"template" text NOT NULL,
	"limit" numeric(38, 0),
	"status" text DEFAULT 'pending_confirmation' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "key_access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"allowed" boolean NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_stats" (
	"tag" text NOT NULL,
	"tier" text NOT NULL,
	"model_or_seller" text NOT NULL,
	"tasks" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"cost_per_pass" numeric(38, 0),
	"refunds" integer DEFAULT 0 NOT NULL,
	"pass_rate" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaderboard_stats_tag_tier_model_or_seller_pk" PRIMARY KEY("tag","tier","model_or_seller")
);
--> statement-breakpoint
CREATE TABLE "members_cache" (
	"account_id" text NOT NULL,
	"department_id" text NOT NULL,
	"company_id" text,
	"scopes" jsonb NOT NULL,
	"limit" numeric(38, 0),
	"expires_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"view_key" text,
	"block_height" bigint,
	"near_tx" text,
	CONSTRAINT "members_cache_account_id_department_id_pk" PRIMARY KEY("account_id","department_id")
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"rail" text NOT NULL,
	"tier" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost" numeric(38, 0),
	"latency_ms" integer,
	"outcome" text NOT NULL,
	"receipt_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account" text NOT NULL,
	"company_id" text,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" text NOT NULL,
	"description" text NOT NULL,
	"key_version" integer NOT NULL,
	"features" jsonb NOT NULL,
	"estimate" jsonb NOT NULL,
	"tier" text NOT NULL,
	"approved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commit_sha" text NOT NULL,
	"file" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"cost" numeric(38, 0),
	"receipt_id" text,
	"attestation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rail_floats" (
	"department_id" text NOT NULL,
	"rail" text NOT NULL,
	"target" numeric(38, 0),
	"balance" numeric(38, 0) DEFAULT '0',
	"reserved" numeric(38, 0) DEFAULT '0',
	"enabled" boolean DEFAULT true NOT NULL,
	"topups_today" integer DEFAULT 0 NOT NULL,
	"topups_day" text,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rail_floats_department_id_rail_pk" PRIMARY KEY("department_id","rail")
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"company_id" text,
	"department_id" text,
	"actor" text,
	"amount" numeric(38, 0),
	"token" text,
	"rail" text,
	"chain_id" text,
	"foreign_tx" text,
	"verified_on_chain" boolean,
	"verify_error" text,
	"request_id" text,
	"event_id" bigint,
	"payload" jsonb NOT NULL,
	"block_height" bigint,
	"near_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_options" (
	"service" text NOT NULL,
	"seller_id" text NOT NULL,
	"rail" text NOT NULL,
	"price" numeric(38, 0),
	"quality_note" text,
	"endpoint" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_options_service_seller_id_pk" PRIMARY KEY("service","seller_id")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" text NOT NULL,
	"seller" text NOT NULL,
	"resource" text NOT NULL,
	"renews_at" timestamp with time zone,
	"cancel_url" text,
	"last_used_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" text NOT NULL,
	"seller" text NOT NULL,
	"channel_id" text,
	"wallet_address" text,
	"deposit_cap" numeric(38, 0) NOT NULL,
	"spent" numeric(38, 0) DEFAULT '0' NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"company_id" text NOT NULL,
	"department_id" text,
	"title" text NOT NULL,
	"tag" text NOT NULL,
	"size" text NOT NULL,
	"tier" text NOT NULL,
	"pinned_model" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"est_p50" numeric(38, 0),
	"est_p90" numeric(38, 0),
	"cap" numeric(38, 0),
	"status" text DEFAULT 'pending' NOT NULL,
	"pause_reason" text,
	"agent" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"commit_sha" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"token" text NOT NULL,
	"to" text NOT NULL,
	"chain" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wrapped_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"department_id" text,
	"version" integer NOT NULL,
	"member_account" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_cards_company_idx" ON "approval_cards" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_cards_daily_uq" ON "approval_cards" USING btree ("company_id","kind","day");--> statement-breakpoint
CREATE INDEX "auth_sessions_account_idx" ON "auth_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "departments_company_idx" ON "departments" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_receipt_log_uq" ON "events" USING btree ("receipt_id","log_index");--> statement-breakpoint
CREATE INDEX "events_company_idx" ON "events" USING btree ("company_id","id");--> statement-breakpoint
CREATE INDEX "members_account_idx" ON "members_cache" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "notifications_account_idx" ON "notifications" USING btree ("account","created_at");--> statement-breakpoint
CREATE INDEX "receipts_company_idx" ON "receipts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "receipts_request_idx" ON "receipts" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_event_uq" ON "receipts" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "tasks_plan_idx" ON "tasks" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "wrapped_keys_uq" ON "wrapped_keys" USING btree ("company_id","kind","department_id","version","member_account");