CREATE TABLE `causal` (
	`id` text PRIMARY KEY NOT NULL,
	`causal_project_document_id` text NOT NULL,
	`extraction_class_id` text NOT NULL,
	`head` text NOT NULL,
	`relationship` text NOT NULL,
	`tail` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`causal_project_document_id`) REFERENCES `causal_project_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extraction_class_id`) REFERENCES `extraction_classes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `causal_project_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`component_id` text NOT NULL,
	`status` text DEFAULT 'raw_text' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`component_id`) REFERENCES `project_components`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "causal_project_documents_status_check" CHECK("causal_project_documents"."status" IN ('raw_text', 'chunked', 'extracted'))
);
--> statement-breakpoint
CREATE INDEX `idx_causal_project_documents_component_id` ON `causal_project_documents` (`component_id`);--> statement-breakpoint
CREATE TABLE `component_project_links` (
	`id` text PRIMARY KEY NOT NULL,
	`component_id` text NOT NULL,
	`project_id` text NOT NULL,
	`role` text DEFAULT 'PRIMARY' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`component_id`) REFERENCES `project_components`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "component_project_links_role_check" CHECK("component_project_links"."role" IN ('PRIMARY', 'LEFT', 'RIGHT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `component_project_links_unique` ON `component_project_links` (`component_id`,`project_id`,`role`);--> statement-breakpoint
CREATE INDEX `idx_component_project_links_component_id` ON `component_project_links` (`component_id`);--> statement-breakpoint
CREATE INDEX `idx_component_project_links_project_id` ON `component_project_links` (`project_id`);--> statement-breakpoint
CREATE TABLE `extraction_classes` (
	`id` text PRIMARY KEY NOT NULL,
	`causal_project_document_id` text NOT NULL,
	`chunk_id` text,
	`pattern_type` text,
	`sentence_type` text,
	`marked_type` text,
	`explicit_type` text,
	`marker` text,
	`source_text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`causal_project_document_id`) REFERENCES `causal_project_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chunk_id`) REFERENCES `text_chunks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `follow_up_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`answer_text` text NOT NULL,
	`answered_by` text DEFAULT 'user' NOT NULL,
	`answered_at` text NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `follow_up_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `follow_up_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`follow_up_id` text NOT NULL,
	`question_text` text NOT NULL,
	`generated_by` text DEFAULT 'system' NOT NULL,
	`generated_at` text NOT NULL,
	`is_filtered_in` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`follow_up_id`) REFERENCES `follow_ups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `follow_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`causal_project_document_id` text NOT NULL,
	`causal_id` text NOT NULL,
	`source_text` text NOT NULL,
	`sentence_type` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`causal_project_document_id`) REFERENCES `causal_project_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`causal_id`) REFERENCES `causal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `generated_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`causal_id` text NOT NULL,
	`entity_name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`causal_id`) REFERENCES `causal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generated_entities_causal_entity_unique` ON `generated_entities` (`causal_id`,`entity_name`);--> statement-breakpoint
CREATE TABLE `input_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`causal_project_document_id` text NOT NULL,
	`input_mode` text NOT NULL,
	`source_type` text NOT NULL,
	`original_file_name` text,
	`storage_path` text,
	`raw_text` text,
	`transcript_text` text,
	`uploaded_at` text NOT NULL,
	FOREIGN KEY (`causal_project_document_id`) REFERENCES `causal_project_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "input_documents_input_mode_check" CHECK("input_documents"."input_mode" IN ('text', 'file')),
	CONSTRAINT "input_documents_source_type_check" CHECK("input_documents"."source_type" IN ('text', 'audio'))
);
--> statement-breakpoint
CREATE INDEX `idx_input_documents_cpd_uploaded_at` ON `input_documents` (`causal_project_document_id`,`uploaded_at`);--> statement-breakpoint
CREATE TABLE `project_components` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`last_edited_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "project_components_category_check" CHECK("project_components"."category" IN ('Causal', 'Map', 'Code', 'Policy_Testing'))
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);--> statement-breakpoint
CREATE TABLE `recents` (
	`component_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`project_id` text,
	`href` text NOT NULL,
	`opened_at` text NOT NULL,
	CONSTRAINT "recents_category_check" CHECK("recents"."category" IN ('Causal', 'Map', 'Code', 'PolicyTesting'))
);
--> statement-breakpoint
CREATE INDEX `idx_recents_opened_at` ON `recents` (`opened_at`);--> statement-breakpoint
CREATE TABLE `submission_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`causal_project_document_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_ref` text,
	`submitted_count` integer DEFAULT 0 NOT NULL,
	`status_message` text,
	`submitted_at` text NOT NULL,
	FOREIGN KEY (`causal_project_document_id`) REFERENCES `causal_project_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "submission_batches_scope_type_check" CHECK("submission_batches"."scope_type" IN ('GROUP', 'ALL'))
);
--> statement-breakpoint
CREATE TABLE `text_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`causal_project_document_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`text` text NOT NULL,
	`start_offset` integer,
	`end_offset` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`causal_project_document_id`) REFERENCES `causal_project_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `text_chunks_doc_chunk_unique` ON `text_chunks` (`causal_project_document_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `idx_text_chunks_doc_chunk` ON `text_chunks` (`causal_project_document_id`,`chunk_index`);