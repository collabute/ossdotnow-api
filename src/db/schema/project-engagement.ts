import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

import { project } from './projects.js';
import { user } from './auth.js';

export const projectGithubStats = pgTable(
  'project_github_stats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .references(() => project.id, { onDelete: 'cascade' })
      .notNull(),
    repoFullName: text('repo_full_name').notNull(),
    repoHtmlUrl: text('repo_html_url'),
    ownerAvatarUrl: text('owner_avatar_url'),
    homepageUrl: text('homepage_url'),
    language: text('language'),
    topics: jsonb('topics').$type<string[]>(),
    stargazersCount: integer('stargazers_count').notNull().default(0),
    forksCount: integer('forks_count').notNull().default(0),
    openIssuesCount: integer('open_issues_count').notNull().default(0),
    defaultBranch: text('default_branch'),
    repoCreatedAt: timestamp('repo_created_at', { mode: 'date', withTimezone: true }),
    repoUpdatedAt: timestamp('repo_updated_at', { mode: 'date', withTimezone: true }),
    pushedAt: timestamp('pushed_at', { mode: 'date', withTimezone: true }),
    lastFetchedAt: timestamp('last_fetched_at', { mode: 'date', withTimezone: true }),
    fetchStatus: text('fetch_status').$type<'ok' | 'failed'>().notNull().default('ok'),
    fetchError: text('fetch_error'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex('project_github_stats_project_id_unique').on(t.projectId),
    index('project_github_stats_repo_full_name_idx').on(t.repoFullName),
    index('project_github_stats_stargazers_count_idx').on(t.stargazersCount),
    index('project_github_stats_forks_count_idx').on(t.forksCount),
    index('project_github_stats_pushed_at_idx').on(t.pushedAt),
  ],
);

export const savedProject = pgTable(
  'saved_project',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .references(() => project.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('saved_project_project_user_unique').on(t.projectId, t.userId),
    index('saved_project_user_id_idx').on(t.userId),
    index('saved_project_project_id_idx').on(t.projectId),
  ],
);

export const projectInterest = pgTable(
  'project_interest',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .references(() => project.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'cascade' })
      .notNull(),
    type: text('type').$type<'contribution' | 'investment' | 'contact'>().notNull(),
    message: text('message'),
    status: text('status').$type<'new' | 'read' | 'archived'>().notNull().default('new'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex('project_interest_project_user_type_unique').on(t.projectId, t.userId, t.type),
    index('project_interest_project_id_idx').on(t.projectId),
    index('project_interest_user_id_idx').on(t.userId),
    index('project_interest_type_idx').on(t.type),
  ],
);

export const projectReport = pgTable(
  'project_report',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .references(() => project.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    details: text('details'),
    status: text('status').$type<'open' | 'reviewed' | 'dismissed'>().notNull().default('open'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('project_report_project_id_idx').on(t.projectId),
    index('project_report_user_id_idx').on(t.userId),
    index('project_report_status_idx').on(t.status),
  ],
);

export const projectGithubStatsRelations = relations(projectGithubStats, ({ one }) => ({
  project: one(project, {
    fields: [projectGithubStats.projectId],
    references: [project.id],
  }),
}));

export const savedProjectRelations = relations(savedProject, ({ one }) => ({
  project: one(project, {
    fields: [savedProject.projectId],
    references: [project.id],
  }),
  user: one(user, {
    fields: [savedProject.userId],
    references: [user.id],
  }),
}));

export const projectInterestRelations = relations(projectInterest, ({ one }) => ({
  project: one(project, {
    fields: [projectInterest.projectId],
    references: [project.id],
  }),
  user: one(user, {
    fields: [projectInterest.userId],
    references: [user.id],
  }),
}));

export const projectReportRelations = relations(projectReport, ({ one }) => ({
  project: one(project, {
    fields: [projectReport.projectId],
    references: [project.id],
  }),
  user: one(user, {
    fields: [projectReport.userId],
    references: [user.id],
  }),
}));
