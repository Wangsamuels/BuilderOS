CREATE TABLE IF NOT EXISTS "testnet_drips" (
	"account" text PRIMARY KEY NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"tx_hash" text NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
