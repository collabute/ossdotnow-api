import { project, projectInterest, user, waitlist } from '../db/schema/index.js';
import { createTRPCRouter, adminProcedure } from '../trpc.js';
import { count, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { getProviderReadiness } from '../utils/readiness.js';

export const adminRouter = createTRPCRouter({
  dashboard: adminProcedure.query(async ({ ctx }) => {
    const [
      usersCount,
      onboardedUsersCount,
      projectsCount,
      earlyAccessCount,
      pendingProjectsCount,
      approvedProjectsCount,
      rejectedProjectsCount,
      claimedProjectsCount,
      contributorInterestCount,
      investorInterestCount,
      reviewSla,
    ] = await Promise.all([
      ctx.db.select({ count: count() }).from(user),
      ctx.db.select({ count: count() }).from(user).where(isNotNull(user.accountType)),
      ctx.db.select({ count: count() }).from(project),
      ctx.db.select({ count: count() }).from(waitlist),
      ctx.db.select({ count: count() }).from(project).where(eq(project.approvalStatus, 'pending')),
      ctx.db
        .select({ count: count() })
        .from(project)
        .where(eq(project.approvalStatus, 'approved')),
      ctx.db
        .select({ count: count() })
        .from(project)
        .where(eq(project.approvalStatus, 'rejected')),
      ctx.db.select({ count: count() }).from(project).where(isNotNull(project.ownerId)),
      ctx.db
        .select({ count: count() })
        .from(projectInterest)
        .where(eq(projectInterest.type, 'contribution')),
      ctx.db
        .select({ count: count() })
        .from(projectInterest)
        .where(eq(projectInterest.type, 'investment')),
      ctx.db
        .select({
          reviewedCount: count(),
          averageReviewHours: sql<number>`coalesce(avg(extract(epoch from (${project.reviewedAt} - ${project.createdAt})) / 3600), 0)`,
        })
        .from(project)
        .where(isNotNull(project.reviewedAt)),
    ]);

    // get the latest 5 projects
    const latestProjects = await ctx.db
      .select()
      .from(project)
      .orderBy(desc(project.createdAt))
      .limit(5);

    if (!usersCount[0] || !projectsCount[0] || !earlyAccessCount[0]) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get waitlist count',
      });
    }

    return {
      counts: {
        users: usersCount[0].count ?? 0,
        onboardedUsers: onboardedUsersCount[0]?.count ?? 0,
        projects: projectsCount[0].count ?? 0,
        earlyAccess: earlyAccessCount[0].count ?? 0,
        pendingProjects: pendingProjectsCount[0]?.count ?? 0,
        approvedProjects: approvedProjectsCount[0]?.count ?? 0,
        rejectedProjects: rejectedProjectsCount[0]?.count ?? 0,
        claimedProjects: claimedProjectsCount[0]?.count ?? 0,
        contributorInterest: contributorInterestCount[0]?.count ?? 0,
        investorInterest: investorInterestCount[0]?.count ?? 0,
      },
      reviewSla: {
        reviewedCount: reviewSla[0]?.reviewedCount ?? 0,
        averageReviewHours: Number(reviewSla[0]?.averageReviewHours ?? 0),
      },
      providerStatus: getProviderReadiness(),
      latestProjects,
    };
  }),
});
