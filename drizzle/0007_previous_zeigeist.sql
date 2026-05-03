CREATE TYPE "public"."user_account_type" AS ENUM('owner', 'contributor', 'investor');--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "account_type" "user_account_type";--> statement-breakpoint
UPDATE "project" SET "approval_status" = 'pending' WHERE "approval_status" IS NULL;
