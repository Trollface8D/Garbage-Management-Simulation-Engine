CREATE TABLE `component_trash` (
	`component_id` text PRIMARY KEY NOT NULL,
	`deleted_at` text NOT NULL,
	FOREIGN KEY (`component_id`) REFERENCES `project_components`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_component_trash_deleted_at` ON `component_trash` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `project_trash` (
	`project_id` text PRIMARY KEY NOT NULL,
	`deleted_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_trash_deleted_at` ON `project_trash` (`deleted_at`);