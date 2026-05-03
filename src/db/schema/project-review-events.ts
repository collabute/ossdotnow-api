import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

import { project } from './projects.js';
import { user } from './auth.js';

export const projectReviewEvent = pgTable('project_review_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .references(() => project.id, { onDelete: 'cascade' })
    .notNull(),
  adminId: text('admin_id')
    .references(() => user.id)
    .notNull(),
  action: text('action').$type<'approved' | 'rejected'>().notNull(),
  reason: text('reason'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
});

export const projectReviewEventRelations = relations(projectReviewEvent, ({ one }) => ({
  project: one(project, {
    fields: [projectReviewEvent.projectId],
    references: [project.id],
  }),
  admin: one(user, {
    fields: [projectReviewEvent.adminId],
    references: [user.id],
  }),
}));
