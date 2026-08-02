CREATE TABLE `shared_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
