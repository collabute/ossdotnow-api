CREATE TABLE "project_github_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"repo_html_url" text,
	"owner_avatar_url" text,
	"homepage_url" text,
	"language" text,
	"topics" jsonb,
	"stargazers_count" integer DEFAULT 0 NOT NULL,
	"forks_count" integer DEFAULT 0 NOT NULL,
	"open_issues_count" integer DEFAULT 0 NOT NULL,
	"default_branch" text,
	"repo_created_at" timestamp with time zone,
	"repo_updated_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"last_fetched_at" timestamp with time zone,
	"fetch_status" text DEFAULT 'ok' NOT NULL,
	"fetch_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_interest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"message" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_github_stats" ADD CONSTRAINT "project_github_stats_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_interest" ADD CONSTRAINT "project_interest_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_interest" ADD CONSTRAINT "project_interest_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_report" ADD CONSTRAINT "project_report_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_report" ADD CONSTRAINT "project_report_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_project" ADD CONSTRAINT "saved_project_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_project" ADD CONSTRAINT "saved_project_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_github_stats_project_id_unique" ON "project_github_stats" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_github_stats_repo_full_name_idx" ON "project_github_stats" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX "project_github_stats_stargazers_count_idx" ON "project_github_stats" USING btree ("stargazers_count");--> statement-breakpoint
CREATE INDEX "project_github_stats_forks_count_idx" ON "project_github_stats" USING btree ("forks_count");--> statement-breakpoint
CREATE INDEX "project_github_stats_pushed_at_idx" ON "project_github_stats" USING btree ("pushed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_interest_project_user_type_unique" ON "project_interest" USING btree ("project_id","user_id","type");--> statement-breakpoint
CREATE INDEX "project_interest_project_id_idx" ON "project_interest" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_interest_user_id_idx" ON "project_interest" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_interest_type_idx" ON "project_interest" USING btree ("type");--> statement-breakpoint
CREATE INDEX "project_report_project_id_idx" ON "project_report" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_report_user_id_idx" ON "project_report" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_report_status_idx" ON "project_report" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_project_project_user_unique" ON "saved_project" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "saved_project_user_id_idx" ON "saved_project" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "saved_project_project_id_idx" ON "saved_project" USING btree ("project_id");