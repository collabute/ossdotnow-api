import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

import { user } from './auth.js';

export const contributorProfile = pgTable(
  'contributor_profile',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'cascade' })
      .notNull(),
    skills: jsonb('skills').$type<string[]>().default([]).notNull(),
    interests: jsonb('interests').$type<string[]>().default([]).notNull(),
    githubHandle: text('github_handle'),
    availability: text('availability'),
    preferredProjectTypes: jsonb('preferred_project_types').$type<string[]>().default([]).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [uniqueIndex('contributor_profile_user_id_unique').on(t.userId)],
);

export const investorProfile = pgTable(
  'investor_profile',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'cascade' })
      .notNull(),
    thesis: text('thesis'),
    stages: jsonb('stages').$type<string[]>().default([]).notNull(),
    sectors: jsonb('sectors').$type<string[]>().default([]).notNull(),
    checkSize: text('check_size'),
    geography: text('geography'),
    contactPreference: text('contact_preference'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [uniqueIndex('investor_profile_user_id_unique').on(t.userId)],
);

export const contributorProfileRelations = relations(contributorProfile, ({ one }) => ({
  user: one(user, {
    fields: [contributorProfile.userId],
    references: [user.id],
  }),
}));

export const investorProfileRelations = relations(investorProfile, ({ one }) => ({
  user: one(user, {
    fields: [investorProfile.userId],
    references: [user.id],
  }),
}));
