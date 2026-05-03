import { adminProcedure, createTRPCRouter } from '../trpc.js';
import { account, project, session, user } from '../db/schema/index.js';
import { count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import z from 'zod/v4';

const userRoleSchema = z.enum(['admin', 'user', 'moderator']);

function normalizeProviderId(providerId: string, hasPassword?: boolean | null) {
  if (providerId === 'credential' || providerId === 'email-password' || hasPassword) {
    return 'email-password';
  }

  return providerId;
}

export const usersRouter = createTRPCRouter({
  getUsers: adminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const users = await ctx.db.query.user.findMany({
        limit: input.limit,
        offset: input.offset,
        orderBy: [desc(user.createdAt)],
        columns: {
          id: true,
          email: true,
          emailVerified: true,
          name: true,
          image: true,
          role: true,
          accountType: true,
          banned: true,
          banReason: true,
          banExpires: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const userIds = users.map((selectedUser) => selectedUser.id);

      if (userIds.length === 0) return [];

      const [linkedAccounts, projectCounts] = await Promise.all([
        ctx.db
          .select({
            userId: account.userId,
            providerId: account.providerId,
            hasPassword: sql<boolean>`${account.password} is not null`,
            scope: account.scope,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          })
          .from(account)
          .where(inArray(account.userId, userIds)),
        ctx.db
          .select({
            ownerId: project.ownerId,
            count: count(),
          })
          .from(project)
          .where(inArray(project.ownerId, userIds))
          .groupBy(project.ownerId),
      ]);
      const accountMap = new Map<string, typeof linkedAccounts>();
      const projectCountMap = new Map(
        projectCounts
          .filter((item) => item.ownerId)
          .map((item) => [item.ownerId as string, item.count]),
      );

      for (const linkedAccount of linkedAccounts) {
        const existingAccounts = accountMap.get(linkedAccount.userId) ?? [];
        existingAccounts.push(linkedAccount);
        accountMap.set(linkedAccount.userId, existingAccounts);
      }

      return users.map((selectedUser) => {
        const accounts = accountMap.get(selectedUser.id) ?? [];
        const connectedProviders = Array.from(
          new Set(
            accounts.map((linkedAccount) =>
              normalizeProviderId(linkedAccount.providerId, linkedAccount.hasPassword),
            ),
          ),
        );

        return {
          ...selectedUser,
          connectedProviders,
          accounts: accounts.map((linkedAccount) => ({
            providerId: normalizeProviderId(
              linkedAccount.providerId,
              linkedAccount.hasPassword,
            ),
            scope: linkedAccount.scope,
            createdAt: linkedAccount.createdAt,
            updatedAt: linkedAccount.updatedAt,
          })),
          ownedProjectCount: projectCountMap.get(selectedUser.id) ?? 0,
        };
      });
    }),
  updateUserRole: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        role: userRoleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const targetUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
        columns: {
          id: true,
          role: true,
        },
      });

      if (!targetUser) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found.',
        });
      }

      if (input.userId === ctx.user.id && input.role !== 'admin') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You cannot remove your own admin role.',
        });
      }

      if (targetUser.role === 'admin' && input.role !== 'admin') {
        const [adminCount] = await ctx.db
          .select({ count: count() })
          .from(user)
          .where(eq(user.role, 'admin'));

        if ((adminCount?.count ?? 0) <= 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'At least one admin must remain.',
          });
        }
      }

      const [updatedUser] = await ctx.db
        .update(user)
        .set({
          role: input.role,
          updatedAt: new Date(),
        })
        .where(eq(user.id, input.userId))
        .returning({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        });

      if (!updatedUser) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found.',
        });
      }

      return updatedUser;
    }),
  suspendUser: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().trim().min(3).max(500),
        banExpires: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You cannot suspend your own account.',
        });
      }

      const targetUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
        columns: {
          id: true,
          role: true,
        },
      });

      if (!targetUser) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found.',
        });
      }

      if (targetUser.role === 'admin') {
        const [adminCount] = await ctx.db
          .select({ count: count() })
          .from(user)
          .where(eq(user.role, 'admin'));

        if ((adminCount?.count ?? 0) <= 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'At least one active admin must remain.',
          });
        }
      }

      const [updatedUser] = await ctx.db.transaction(async (tx) => {
        const updatedUsers = await tx
          .update(user)
          .set({
            banned: true,
            banReason: input.reason.trim(),
            banExpires: input.banExpires ?? null,
            updatedAt: new Date(),
          })
          .where(eq(user.id, input.userId))
          .returning({
            id: user.id,
            email: user.email,
            name: user.name,
            banned: user.banned,
            banReason: user.banReason,
            banExpires: user.banExpires,
          });

        await tx.delete(session).where(eq(session.userId, input.userId));

        return updatedUsers;
      });

      if (!updatedUser) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found.',
        });
      }

      return updatedUser;
    }),
  unsuspendUser: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updatedUser] = await ctx.db
        .update(user)
        .set({
          banned: false,
          banReason: null,
          banExpires: null,
          updatedAt: new Date(),
        })
        .where(eq(user.id, input.userId))
        .returning({
          id: user.id,
          email: user.email,
          name: user.name,
          banned: user.banned,
          banReason: user.banReason,
          banExpires: user.banExpires,
        });

      if (!updatedUser) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found.',
        });
      }

      return updatedUser;
    }),
});
