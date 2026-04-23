CREATE TABLE `codegen_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`component_id` text,
	`causal_project_document_id` text,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`model` text,
	`input_prompt` text,
	`started_at` text,
	`finished_at` text,
	`duration_ms` integer,
	`input_entity_count` integer DEFAULT 0 NOT NULL,
	`generated_entity_count` integer DEFAULT 0 NOT NULL,
	`generated_file_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`component_id`) REFERENCES `project_components`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`causal_project_document_id`) REFERENCES `causal_project_documents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `codegen_runs_source_type_check` CHECK(`codegen_runs`.`source_type` IN ('manual', 'derived_causal', 'follow_up', 'imported')),
	CONSTRAINT `codegen_runs_status_check` CHECK(`codegen_runs`.`status` IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_codegen_runs_project_id` ON `codegen_runs` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_codegen_runs_component_id` ON `codegen_runs` (`component_id`);
--> statement-breakpoint
CREATE INDEX `idx_codegen_runs_status` ON `codegen_runs` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_codegen_runs_created_at` ON `codegen_runs` (`created_at`);
--> statement-breakpoint
CREATE TABLE `codegen_input_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`entity_name` text NOT NULL,
	`source_causal_id` text,
	`source_head` text,
	`source_relationship` text,
	`source_tail` text,
	`source_detail` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `codegen_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_causal_id`) REFERENCES `causal`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codegen_input_entities_run_entity_unique` ON `codegen_input_entities` (`run_id`,`entity_name`);
--> statement-breakpoint
CREATE INDEX `idx_codegen_input_entities_run_id` ON `codegen_input_entities` (`run_id`);
--> statement-breakpoint
CREATE TABLE `codegen_generated_files` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`entity_name` text NOT NULL,
	`file_path` text NOT NULL,
	`language` text,
	`file_size_bytes` integer,
	`generation_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `codegen_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codegen_generated_files_run_path_unique` ON `codegen_generated_files` (`run_id`,`file_path`);
--> statement-breakpoint
CREATE INDEX `idx_codegen_generated_files_run_id` ON `codegen_generated_files` (`run_id`);
--> statement-breakpoint
CREATE INDEX `idx_codegen_generated_files_entity_name` ON `codegen_generated_files` (`entity_name`);
--> statement-breakpoint
CREATE TABLE `codegen_run_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`metric_key` text NOT NULL,
	`metric_type` text DEFAULT 'text' NOT NULL,
	`metric_value` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `codegen_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `codegen_run_metrics_metric_type_check` CHECK(`codegen_run_metrics`.`metric_type` IN ('text', 'number', 'boolean', 'json'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codegen_run_metrics_run_key_unique` ON `codegen_run_metrics` (`run_id`,`metric_key`);
--> statement-breakpoint
CREATE INDEX `idx_codegen_run_metrics_run_id` ON `codegen_run_metrics` (`run_id`);