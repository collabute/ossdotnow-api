import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod/v4';

import {
  account,
  contributorProfile,
  investorProfile,
  project,
  session as sessionTable,
  user,
} from '../db/schema/index.js';
import { createTRPCRouter, protectedProcedure } from '../trpc.js';

const accountTypeSchema = z.enum(['owner', 'contributor', 'investor']);
const manageableProviderSchema = z.enum(['github', 'email-password']);
const projectTags = [
  'web',
  'mobile',
  'desktop',
  'backend',
  'frontend',
  'fullstack',
  'ai',
  'game',
  'crypto',
  'nft',
  'social',
  'other',
  'dapp',
  'saas',
  'algorithm',
  'data-analysis',
  'game-engine',
] as const;
const projectTypes = [
  'fintech',
  'healthtech',
  'edtech',
  'ecommerce',
  'productivity',
  'social',
  'entertainment',
  'developer-tools',
  'content-management',
  'analytics',
  'other',
] as const;
const projectStages = [
  'active',
  'early-stage',
  'beta',
  'production-ready',
  'experimental',
] as const;
const availabilityOptions = [
  'open',
  'part-time',
  'weekends',
  'advisory',
  'not-available',
] as const;

const contributorProfileInput = z.object({
  skills: z.array(z.enum(projectTags)).max(12),
  interests: z.array(z.enum(projectTags)).max(12),
  githubHandle: z.string().trim().max(80).optional(),
  availability: z.enum(availabilityOptions).optional(),
  preferredProjectTypes: z.array(z.enum(projectTypes)).max(8),
});
const investorProfileInput = z.object({
  thesis: z.string().trim().max(1200).optional(),
  stages: z.array(z.enum(projectStages)).max(8),
  sectors: z.array(z.enum(projectTypes)).max(8),
  checkSize: z.string().trim().max(80).optional(),
  geography: z.string().trim().max(120).optional(),
  contactPreference: z.string().trim().max(160).optional(),
});
const profileInput = z.object({
  name: z.string().trim().min(1).max(120),
  image: z.string().trim().max(2048).optional(),
});

function nullableText(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeProviderId(providerId: string, password?: string | null) {
  if (providerId === 'credential' || providerId === 'email-password' || password) {
    return 'email-password';
  }

  return providerId;
}

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx }) => {
    const profile = await ctx.db.query.user.findFirst({
      where: eq(user.id, ctx.user.id),
    });
    const linkedAccounts = await ctx.db
      .select({ providerId: account.providerId, password: account.password })
      .from(account)
      .where(eq(account.userId, ctx.user.id));
    const connectedProviders = Array.from(
      new Set(
        linkedAccounts.map((linkedAccount) =>
          normalizeProviderId(linkedAccount.providerId, linkedAccount.password),
        ),
      ),
    );

    return {
      ...ctx.user,
      accountType: profile?.accountType ?? null,
      connectedProviders,
      session: {
        id: ctx.session.id,
        ipAddress: ctx.session.ipAddress,
        userAgent: ctx.session.userAgent,
      },
    };
  }),
  updateProfile: protectedProcedure.input(profileInput).mutation(async ({ ctx, input }) => {
    const [updatedUser] = await ctx.db
      .update(user)
      .set({
        name: input.name,
        image: nullableText(input.image),
        updatedAt: new Date(),
      })
      .where(eq(user.id, ctx.user.id))
      .returning({
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
        accountType: user.accountType,
        emailVerified: user.emailVerified,
      });

    if (!updatedUser) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'User not found',
      });
    }

    return updatedUser;
  }),
  getAccountSecurity: protectedProcedure.query(async ({ ctx }) => {
    const [profile, linkedAccounts, sessions] = await Promise.all([
      ctx.db.query.user.findFirst({
        where: eq(user.id, ctx.user.id),
      }),
      ctx.db
        .select({
          id: account.id,
          accountId: account.accountId,
          providerId: account.providerId,
          scope: account.scope,
          hasPassword: sql<boolean>`${account.password} is not null`,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        })
        .from(account)
        .where(eq(account.userId, ctx.user.id))
        .orderBy(desc(account.updatedAt)),
      ctx.db
        .select({
          id: sessionTable.id,
          expiresAt: sessionTable.expiresAt,
          createdAt: sessionTable.createdAt,
          updatedAt: sessionTable.updatedAt,
          ipAddress: sessionTable.ipAddress,
          userAgent: sessionTable.userAgent,
        })
        .from(sessionTable)
        .where(eq(sessionTable.userId, ctx.user.id))
        .orderBy(desc(sessionTable.updatedAt)),
    ]);

    const accountGroups = new Map<
      string,
      {
        providerId: string;
        accountCount: number;
        accountIds: string[];
        accountId: string;
        scope: string | null;
        hasPassword: boolean;
        createdAt: Date;
        updatedAt: Date;
      }
    >();

    for (const linkedAccount of linkedAccounts) {
      const providerId = normalizeProviderId(
        linkedAccount.providerId,
        linkedAccount.hasPassword ? 'password' : null,
      );
      const existingAccount = accountGroups.get(providerId);

      if (!existingAccount) {
        accountGroups.set(providerId, {
          providerId,
          accountCount: 1,
          accountIds: [linkedAccount.id],
          accountId: linkedAccount.accountId,
          scope: linkedAccount.scope,
          hasPassword: linkedAccount.hasPassword,
          createdAt: linkedAccount.createdAt,
          updatedAt: linkedAccount.updatedAt,
        });
        continue;
      }

      existingAccount.accountCount += 1;
      existingAccount.accountIds.push(linkedAccount.id);
      existingAccount.hasPassword = existingAccount.hasPassword || linkedAccount.hasPassword;
      existingAccount.updatedAt =
        linkedAccount.updatedAt > existingAccount.updatedAt
          ? linkedAccount.updatedAt
          : existingAccount.updatedAt;
      existingAccount.createdAt =
        linkedAccount.createdAt < existingAccount.createdAt
          ? linkedAccount.createdAt
          : existingAccount.createdAt;
      existingAccount.scope = existingAccount.scope ?? linkedAccount.scope;
    }

    return {
      user: {
        id: profile?.id ?? ctx.user.id,
        name: profile?.name ?? ctx.user.name,
        email: profile?.email ?? ctx.user.email,
        image: profile?.image ?? ctx.user.image ?? null,
        emailVerified: profile?.emailVerified ?? ctx.user.emailVerified,
        role: profile?.role ?? ctx.user.role,
        accountType: profile?.accountType ?? null,
      },
      accounts: Array.from(accountGroups.values()),
      sessions: sessions.map((session) => ({
        ...session,
        isCurrent: session.id === ctx.session.id,
      })),
    };
  }),
  disconnectProvider: protectedProcedure
    .input(
      z.object({
        providerId: manageableProviderSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const linkedAccounts = await ctx.db
        .select({
          id: account.id,
          providerId: account.providerId,
          password: account.password,
        })
        .from(account)
        .where(eq(account.userId, ctx.user.id));

      const connectedProviders = new Set(
        linkedAccounts.map((linkedAccount) =>
          normalizeProviderId(linkedAccount.providerId, linkedAccount.password),
        ),
      );

      if (!connectedProviders.has(input.providerId)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That provider is not connected to this account.',
        });
      }

      if (connectedProviders.size <= 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Connect another sign-in method before disconnecting this provider.',
        });
      }

      const accountIdsToDelete = linkedAccounts
        .filter(
          (linkedAccount) =>
            normalizeProviderId(linkedAccount.providerId, linkedAccount.password) ===
            input.providerId,
        )
        .map((linkedAccount) => linkedAccount.id);

      if (accountIdsToDelete.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That provider is not connected to this account.',
        });
      }

      await ctx.db.delete(account).where(inArray(account.id, accountIdsToDelete));

      return {
        disconnectedProvider: input.providerId,
      };
    }),
  signOutEverywhere: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(sessionTable).where(eq(sessionTable.userId, ctx.user.id));

    return {
      success: true,
    };
  }),
  updateAccountType: protectedProcedure
    .input(
      z.object({
        accountType: accountTypeSchema,
        confirmOwnerProjectVisibility: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const currentUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, ctx.user.id),
        columns: {
          accountType: true,
        },
      });

      if (currentUser?.accountType === 'owner' && input.accountType !== 'owner') {
        const [ownedProjectCount] = await ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(project)
          .where(and(eq(project.ownerId, ctx.user.id), isNull(project.deletedAt)));
        const count = Number(ownedProjectCount?.count ?? 0);

        if (count > 0 && !input.confirmOwnerProjectVisibility) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Switching away from owner hides project management until you switch back. Confirm to continue.',
          });
        }
      }

      const [updatedUser] = await ctx.db
        .update(user)
        .set({
          accountType: input.accountType,
          updatedAt: new Date(),
        })
        .where(eq(user.id, ctx.user.id))
        .returning({
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
          accountType: user.accountType,
        });

      if (!updatedUser) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }

      return updatedUser;
    }),
  getContributorProfile: protectedProcedure.query(({ ctx }) => {
    return ctx.db.query.contributorProfile.findFirst({
      where: eq(contributorProfile.userId, ctx.user.id),
    });
  }),
  upsertContributorProfile: protectedProcedure
    .input(contributorProfileInput)
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const [profile] = await ctx.db
        .insert(contributorProfile)
        .values({
          userId: ctx.user.id,
          skills: input.skills,
          interests: input.interests,
          githubHandle: nullableText(input.githubHandle),
          availability: input.availability ?? null,
          preferredProjectTypes: input.preferredProjectTypes,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: contributorProfile.userId,
          set: {
            skills: input.skills,
            interests: input.interests,
            githubHandle: nullableText(input.githubHandle),
            availability: input.availability ?? null,
            preferredProjectTypes: input.preferredProjectTypes,
            updatedAt: now,
          },
        })
        .returning();

      if (!profile) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Could not save contributor profile.',
        });
      }

      return profile;
    }),
  getInvestorProfile: protectedProcedure.query(({ ctx }) => {
    return ctx.db.query.investorProfile.findFirst({
      where: eq(investorProfile.userId, ctx.user.id),
    });
  }),
  upsertInvestorProfile: protectedProcedure
    .input(investorProfileInput)
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const [profile] = await ctx.db
        .insert(investorProfile)
        .values({
          userId: ctx.user.id,
          thesis: nullableText(input.thesis),
          stages: input.stages,
          sectors: input.sectors,
          checkSize: nullableText(input.checkSize),
          geography: nullableText(input.geography),
          contactPreference: nullableText(input.contactPreference),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: investorProfile.userId,
          set: {
            thesis: nullableText(input.thesis),
            stages: input.stages,
            sectors: input.sectors,
            checkSize: nullableText(input.checkSize),
            geography: nullableText(input.geography),
            contactPreference: nullableText(input.contactPreference),
            updatedAt: now,
          },
        })
        .returning();

      if (!profile) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Could not save investor profile.',
        });
      }

      return profile;
    }),
});
