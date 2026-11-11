CREATE TABLE IF NOT EXISTS "company_links" (
	"account_id" text NOT NULL,
	"company_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_links_account_id_company_id_pk" PRIMARY KEY("account_id","company_id")
);
--> statement-breakpoint
-- Backfill: every company an account asked the API to create (the saved POST /v1/companies response).
INSERT INTO "company_links" ("account_id", "company_id", "source")
SELECT DISTINCT "account_id", lower("response"->>'companyId'), 'backfill'
FROM "idempotency_keys"
WHERE "route" = '/v1/companies' AND "status" < 300 AND coalesce("response"->>'companyId', '') <> ''
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- And every company the indexer already saw, for its founder.
INSERT INTO "company_links" ("account_id", "company_id", "source")
SELECT "founder_account", "id", 'backfill' FROM "companies"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "view_keys" (
	"account_id" text NOT NULL,
	"company_id" text NOT NULL,
	"x25519_public_key" text NOT NULL,
	"near_tx" text,
	"block_height" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "view_keys_account_id_company_id_pk" PRIMARY KEY("account_id","company_id")
);
--> statement-breakpoint
INSERT INTO "view_keys" ("account_id", "company_id", "x25519_public_key")
SELECT DISTINCT ON ("account_id", "company_id") "account_id", "company_id", "view_key" FROM "members_cache"
WHERE "view_key" IS NOT NULL AND "company_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "address_balances" (
	"address" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"department_id" text,
	"balance" numeric(38, 0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
