CREATE TABLE `map_project_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`component_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`component_id`) REFERENCES `project_components`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `map_project_documents_status_check` CHECK(`map_project_documents`.`status` IN ('draft', 'extracted', 'edited'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `map_project_documents_component_unique` ON `map_project_documents` (`component_id`);
--> statement-breakpoint
CREATE INDEX `idx_map_project_documents_component_id` ON `map_project_documents` (`component_id`);
--> statement-breakpoint

CREATE TABLE `map_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`map_project_document_id` text NOT NULL,
	`job_id` text,
	`selected_model` text,
	`overview_additional_info` text,
	`bin_additional_info` text,
	`edit_status` text,
	`coordinate_system` text DEFAULT 'normalized' NOT NULL,
	`metadata_json` text,
	`selected_kind` text DEFAULT 'none' NOT NULL,
	`selected_ref_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`map_project_document_id`) REFERENCES `map_project_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `map_snapshots_coordinate_system_check` CHECK(`map_snapshots`.`coordinate_system` IN ('normalized', 'pixel')),
	CONSTRAINT `map_snapshots_selected_kind_check` CHECK(`map_snapshots`.`selected_kind` IN ('none', 'vertex', 'edge'))
);
--> statement-breakpoint
CREATE INDEX `idx_map_snapshots_doc_id` ON `map_snapshots` (`map_project_document_id`);
--> statement-breakpoint
CREATE INDEX `idx_map_snapshots_created_at` ON `map_snapshots` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_map_snapshots_job_id` ON `map_snapshots` (`job_id`);
--> statement-breakpoint

CREATE TABLE `map_snapshot_overview_files` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`file_name` text NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `map_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `map_snapshot_overview_files_snapshot_name_unique` ON `map_snapshot_overview_files` (`snapshot_id`,`file_name`);
--> statement-breakpoint
CREATE INDEX `idx_map_snapshot_overview_files_snapshot_id` ON `map_snapshot_overview_files` (`snapshot_id`);
--> statement-breakpoint

CREATE TABLE `map_snapshot_bin_files` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`file_name` text NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `map_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `map_snapshot_bin_files_snapshot_name_unique` ON `map_snapshot_bin_files` (`snapshot_id`,`file_name`);
--> statement-breakpoint
CREATE INDEX `idx_map_snapshot_bin_files_snapshot_id` ON `map_snapshot_bin_files` (`snapshot_id`);
--> statement-breakpoint

CREATE TABLE `map_vertices` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`vertex_id` text NOT NULL,
	`label` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`vertex_type` text,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `map_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `map_vertices_snapshot_vertex_unique` ON `map_vertices` (`snapshot_id`,`vertex_id`);
--> statement-breakpoint
CREATE INDEX `idx_map_vertices_snapshot_id` ON `map_vertices` (`snapshot_id`);
--> statement-breakpoint

CREATE TABLE `map_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`edge_id` text NOT NULL,
	`source_vertex_id` text NOT NULL,
	`target_vertex_id` text NOT NULL,
	`label` text,
	`weight` real,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `map_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `map_edges_snapshot_edge_unique` ON `map_edges` (`snapshot_id`,`edge_id`);
--> statement-breakpoint
CREATE INDEX `idx_map_edges_snapshot_id` ON `map_edges` (`snapshot_id`);
--> statement-breakpoint
CREATE INDEX `idx_map_edges_source_vertex_id` ON `map_edges` (`source_vertex_id`);
--> statement-breakpoint
CREATE INDEX `idx_map_edges_target_vertex_id` ON `map_edges` (`target_vertex_id`);
--> statement-breakpoint

CREATE TABLE `map_change_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`log_entry` text NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`logged_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `map_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_map_change_logs_snapshot_id` ON `map_change_logs` (`snapshot_id`);
--> statement-breakpoint
CREATE INDEX `idx_map_change_logs_logged_at` ON `map_change_logs` (`logged_at`);
