import { adminProcedure, createTRPCRouter } from '../trpc.js';
import { getRateLimiter } from '../utils/rate-limit.js';
import { createInsertSchema } from 'drizzle-zod';
import { project } from '../db/schema/index.js';
import { TRPCError } from '@trpc/server';
import { count, eq } from 'drizzle-orm';
import { getIp } from '../utils/ip.js';
import { parseGitHubRepoName } from '../utils/github-repo.js';
import { optionalWebUrl, socialLinksInput } from '../utils/web-url.js';

const createProjectInput = createInsertSchema(project).omit({
  id: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
}).extend({
  logoUrl: optionalWebUrl.optional().nullable(),
  socialLinks: socialLinksInput,
});

export const earlySubmissionRouter = createTRPCRouter({
  // Deprecated live-mode archive path. Public project submissions now use projects.createProject.
  addProject: adminProcedure.input(createProjectInput).mutation(async ({ ctx, input }) => {
    const limiter = getRateLimiter('early-submissions');
    if (limiter) {
      const ip = getIp(ctx.headers);
      const safeIp = ip || `anonymous-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const { success } = await limiter.limit(safeIp);

      if (!success) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many requests. Please try again later.',
        });
      }
    }

    const normalizedRepo = parseGitHubRepoName(input.gitRepoUrl);
    const existingProject = await ctx.db.query.project.findFirst({
      where: eq(project.gitRepoUrl, normalizedRepo.fullName),
      columns: { id: true },
    });

    if (existingProject) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This repository already exists in the project review queue.',
      });
    }

    await ctx.db.insert(project).values({
      ...input,
      gitRepoUrl: normalizedRepo.fullName,
      ownerId: null,
      approvalStatus: 'pending',
    });

    return {
      count: count(),
    };
  }),
  getEarlySubmissionsCount: adminProcedure.query(async ({ ctx }) => {
    const earlySubmissionsCount = await ctx.db.select({ count: count() }).from(project);

    if (!earlySubmissionsCount[0]) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get waitlist count',
      });
    }

    return {
      count: earlySubmissionsCount[0].count,
    };
  }),
});
