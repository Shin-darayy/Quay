-- A database stamped as already migrated (see migrate.ts) may predate
-- link_payments entirely; give the ALTERs below something to alter. A no-op
-- everywhere else.
CREATE TABLE IF NOT EXISTS `link_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`tx_hash` text NOT NULL,
	`operation_id` text,
	`payer` text NOT NULL,
	`amount` text NOT NULL,
	`asset_code` text NOT NULL,
	`asset_issuer` text,
	`ledger` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `link_payments_link_id_idx` ON `link_payments` (`link_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `link_payments_tx_hash_operation_id_unique` ON `link_payments` (`tx_hash`,`operation_id`);--> statement-breakpoint
ALTER TABLE `link_payments` ADD `source_asset_code` text;--> statement-breakpoint
ALTER TABLE `link_payments` ADD `source_asset_issuer` text;--> statement-breakpoint
ALTER TABLE `link_payments` ADD `source_amount` text;
