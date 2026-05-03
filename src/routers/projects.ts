import { adminProcedure, createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc.js';
import { Api } from '@octokit/plugin-rest-endpoint-methods';
import {
  account,
  contributorProfile,
  investorProfile,
  project,
  projectGithubStats,
  projectInterest,
  projectReport,
  projectReviewEvent,
  savedProject,
  user as userTable,
} from '../db/schema/index.js';
import { createInsertSchema } from 'drizzle-zod';
import { createOctokitInstance } from './github.js';
import type { createTRPCContext } from '../trpc.js';
import { TRPCError } from '@trpc/server';
import { Octokit } from '@octokit/core';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import { sendAuthEmail } from '../auth/email.js';
import { env } from '../env/server.js';
import { parseGitHubRepoName } from '../utils/github-repo.js';
import { optionalWebUrl, socialLinksInput } from '../utils/web-url.js';

const projectStatuses = [
  'active',
  'inactive',
  'early-stage',
  'beta',
  'production-ready',
  'experimental',
  'cancelled',
  'paused',
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

const projectInput = createInsertSchema(project).omit({
  id: true,
  ownerId: true,
  approvalStatus: true,
  rejectionReason: true,
  reviewedById: true,
  reviewedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  logoUrl: optionalWebUrl.optional().nullable(),
  socialLinks: socialLinksInput,
});
const updateMyProjectInput = projectInput.partial().extend({
  id: z.uuid(),
});
const projectDiscoveryInput = z.object({
  approvalStatus: z.enum(['approved', 'rejected', 'pending', 'all']).optional(),
  search: z.string().trim().max(120).optional(),
  tags: z.array(z.enum(projectTags)).max(12).optional(),
  statuses: z.array(z.enum(projectStatuses)).max(projectStatuses.length).optional(),
  types: z.array(z.enum(projectTypes)).max(projectTypes.length).optional(),
  lookingForContributors: z.boolean().optional(),
  lookingForInvestors: z.boolean().optional(),
  hiring: z.boolean().optional(),
  acquired: z.boolean().optional(),
  host: z.enum(['github', 'gitlab']).optional(),
  sort: z.enum(['relevance', 'newest', 'stars', 'forks', 'activity']).optional(),
});
const projectViewerInput = z.object({ projectId: z.uuid() });
const projectInterestInput = projectViewerInput.extend({
  type: z.enum(['contribution', 'investment', 'contact']),
  message: z.string().trim().max(1200).optional(),
});
const projectReportInput = projectViewerInput.extend({
  reason: z.string().trim().min(3).max(120),
  details: z.string().trim().max(1200).optional(),
});

type Project = typeof project.$inferSelect;
type ProjectGithubStats = typeof projectGithubStats.$inferSelect;
type ProjectWithGithubStats = Project & {
  githubStats: ProjectGithubStats | null;
};
type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;
type GithubStatsContext = {
  db: TRPCContext['db'];
  user?: TRPCContext['user'];
};
type OwnerAccountContext = {
  db: TRPCContext['db'];
  user: {
    id: string;
  };
};

interface VerifyGitHubOwnershipContext {
  db: TRPCContext['db'];
  session: {
    userId: string;
  };
}

async function requireOwnerAccount(ctx: OwnerAccountContext) {
  const currentUser = await ctx.db.query.user.findFirst({
    where: eq(userTable.id, ctx.user.id),
    columns: {
      accountType: true,
    },
  });

  if (currentUser?.accountType !== 'owner') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only owner accounts can create or manage submitted projects.',
    });
  }
}

async function requireLinkedGitHubAccount(ctx: OwnerAccountContext) {
  const userAccount = await ctx.db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, ctx.user.id), eq(account.providerId, 'github')))
    .limit(1);

  if (!userAccount[0]?.accessToken) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message:
        'This repository was already submitted before. Connect your GitHub account to verify ownership and attach it to your dashboard.',
    });
  }
}

async function ensureRepoIdentityIsAvailable(
  ctx: { db: TRPCContext['db'] },
  fullName: string,
  currentProjectId?: string,
) {
  const existingProject = await ctx.db.query.project.findFirst({
    where: eq(project.gitRepoUrl, fullName),
    columns: {
      id: true,
      ownerId: true,
    },
  });

  if (existingProject && existingProject.id !== currentProjectId) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        existingProject.ownerId === null
          ? 'This repository already exists as an unclaimed submission. Use the claim flow to attach it to your dashboard.'
          : 'This repository has already been submitted.',
    });
  }
}

function parseOptionalDate(value: string | null | undefined) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isStatsStale(stats: ProjectGithubStats | null) {
  if (!stats?.lastFetchedAt) return true;

  return Date.now() - stats.lastFetchedAt.getTime() > 6 * 60 * 60 * 1000;
}

async function markGithubStatsRefreshFailed(
  ctx: GithubStatsContext,
  selectedProject: Project,
  error: unknown,
) {
  const now = new Date();
  const fetchError = error instanceof Error ? error.message : 'Could not refresh GitHub stats.';
  const repoFullName = selectedProject.gitRepoUrl || selectedProject.name;

  const [stats] = await ctx.db
    .insert(projectGithubStats)
    .values({
      projectId: selectedProject.id,
      repoFullName,
      fetchStatus: 'failed',
      fetchError,
      lastFetchedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectGithubStats.projectId,
      set: {
        fetchStatus: 'failed',
        fetchError,
        lastFetchedAt: now,
        updatedAt: now,
      },
    })
    .returning();

  return stats ?? null;
}

async function refreshProjectGithubStats(ctx: GithubStatsContext, selectedProject: Project) {
  try {
    const { owner, repo, fullName } = parseGitHubRepoName(selectedProject.gitRepoUrl);
    const github = await createOctokitInstance(ctx);
    const [{ data: repoData }, topicsData] = await Promise.all([
      github.rest.repos.get({ owner, repo }),
      github.rest.repos.getAllTopics({ owner, repo }).catch(() => ({ data: { names: [] } })),
    ]);
    const now = new Date();
    const topics = repoData.topics?.length ? repoData.topics : topicsData.data.names;
    const values = {
      projectId: selectedProject.id,
      repoFullName: fullName,
      repoHtmlUrl: repoData.html_url ?? null,
      ownerAvatarUrl: repoData.owner?.avatar_url ?? null,
      homepageUrl: repoData.homepage || null,
      language: repoData.language ?? null,
      topics,
      stargazersCount: repoData.stargazers_count ?? 0,
      forksCount: repoData.forks_count ?? 0,
      openIssuesCount: repoData.open_issues_count ?? 0,
      defaultBranch: repoData.default_branch ?? null,
      repoCreatedAt: parseOptionalDate(repoData.created_at),
      repoUpdatedAt: parseOptionalDate(repoData.updated_at),
      pushedAt: parseOptionalDate(repoData.pushed_at),
      lastFetchedAt: now,
      fetchStatus: 'ok' as const,
      fetchError: null,
      updatedAt: now,
    };

    const [stats] = await ctx.db
      .insert(projectGithubStats)
      .values(values)
      .onConflictDoUpdate({
        target: projectGithubStats.projectId,
        set: values,
      })
      .returning();

    return stats ?? null;
  } catch (error) {
    console.warn(`Failed to refresh GitHub stats for ${selectedProject.gitRepoUrl}:`, error);
    return markGithubStatsRefreshFailed(ctx, selectedProject, error);
  }
}

async function attachFreshGithubStats(
  ctx: GithubStatsContext,
  rows: Array<{ project: Project; githubStats: ProjectGithubStats | null }>,
) {
  const staleRows = rows.filter((row) => isStatsStale(row.githubStats)).slice(0, 20);

  if (staleRows.length > 0) {
    await Promise.allSettled(staleRows.map((row) => refreshProjectGithubStats(ctx, row.project)));
  }

  const projectIds = rows.map((row) => row.project.id);

  if (projectIds.length === 0) return [];

  const statsRows = await ctx.db
    .select()
    .from(projectGithubStats)
    .where(inArray(projectGithubStats.projectId, projectIds));
  const statsByProjectId = new Map(statsRows.map((stats) => [stats.projectId, stats]));

  return rows.map((row) => ({
    ...row.project,
    githubStats: statsByProjectId.get(row.project.id) ?? row.githubStats ?? null,
  }));
}

function getTime(value: Date | null | undefined) {
  return value?.getTime() ?? 0;
}

function getRelevanceScore(selectedProject: ProjectWithGithubStats, search?: string) {
  if (!search) {
    return getTime(selectedProject.createdAt);
  }

  const query = search.toLowerCase();
  const name = selectedProject.name.toLowerCase();
  const description = selectedProject.description?.toLowerCase() ?? '';
  const repo = selectedProject.gitRepoUrl.toLowerCase();
  let score = 0;

  if (name === query) score += 100;
  if (name.startsWith(query)) score += 50;
  if (name.includes(query)) score += 25;
  if (repo.includes(query)) score += 20;
  if (description.includes(query)) score += 10;
  if (selectedProject.tags?.some((tag) => tag.includes(query))) score += 10;

  return score * 1_000_000 + (selectedProject.githubStats?.stargazersCount ?? 0);
}

function sortProjects(
  projects: ProjectWithGithubStats[],
  sort: 'relevance' | 'newest' | 'stars' | 'forks' | 'activity',
  search?: string,
) {
  return [...projects].sort((a, b) => {
    if (sort === 'stars') {
      return (b.githubStats?.stargazersCount ?? 0) - (a.githubStats?.stargazersCount ?? 0);
    }

    if (sort === 'forks') {
      return (b.githubStats?.forksCount ?? 0) - (a.githubStats?.forksCount ?? 0);
    }

    if (sort === 'activity') {
      return (
        getTime(b.githubStats?.pushedAt ?? b.githubStats?.repoUpdatedAt ?? b.updatedAt) -
        getTime(a.githubStats?.pushedAt ?? a.githubStats?.repoUpdatedAt ?? a.updatedAt)
      );
    }

    if (sort === 'newest') {
      return getTime(b.createdAt) - getTime(a.createdAt);
    }

    return getRelevanceScore(b, search) - getRelevanceScore(a, search);
  });
}

function overlapScore(values: string[] | null | undefined, targetValues: string[] | null | undefined) {
  if (!values?.length || !targetValues?.length) return 0;

  const targetSet = new Set(targetValues);
  return values.filter((value) => targetSet.has(value)).length;
}

function scoreContributorRecommendation(
  selectedProject: ProjectWithGithubStats,
  profile:
    | {
        skills: string[];
        interests: string[];
        preferredProjectTypes: string[];
      }
    | null
    | undefined,
) {
  const preferredTags = [...(profile?.skills ?? []), ...(profile?.interests ?? [])];

  return (
    overlapScore(selectedProject.tags, preferredTags) * 12 +
    (profile?.preferredProjectTypes.includes(selectedProject.type) ? 10 : 0) +
    (selectedProject.isLookingForContributors ? 20 : 0) +
    Math.min(selectedProject.githubStats?.openIssuesCount ?? 0, 20) +
    Math.min(Math.floor((selectedProject.githubStats?.stargazersCount ?? 0) / 100), 10)
  );
}

function scoreInvestorRecommendation(
  selectedProject: ProjectWithGithubStats,
  profile:
    | {
        sectors: string[];
        stages: string[];
      }
    | null
    | undefined,
) {
  return (
    (profile?.sectors.includes(selectedProject.type) ? 14 : 0) +
    (profile?.stages.includes(selectedProject.status) ? 8 : 0) +
    (selectedProject.isLookingForInvestors ? 24 : 0) +
    Math.min(Math.floor((selectedProject.githubStats?.stargazersCount ?? 0) / 100), 12) +
    Math.min(Math.floor((selectedProject.githubStats?.forksCount ?? 0) / 50), 8)
  );
}

function buildProjectDiscoveryFilters(
  input: z.infer<typeof projectDiscoveryInput>,
  isAdmin: boolean,
) {
  const approvalStatus = input.approvalStatus ?? 'approved';
  const filters = [isNull(project.deletedAt)];

  if (approvalStatus !== 'all') {
    filters.push(eq(project.approvalStatus, approvalStatus));
  }

  if (!isAdmin) {
    filters.push(eq(project.approvalStatus, 'approved'));
    filters.push(eq(project.isPublic, true));
  }

  if (input.search) {
    const pattern = `%${input.search}%`;
    filters.push(
      or(
        ilike(project.name, pattern),
        ilike(project.description, pattern),
        ilike(project.gitRepoUrl, pattern),
      )!,
    );
  }

  if (input.tags?.length) {
    filters.push(sql`${project.tags} && ${input.tags}::tags[]`);
  }

  if (input.statuses?.length) {
    filters.push(inArray(project.status, input.statuses));
  }

  if (input.types?.length) {
    filters.push(inArray(project.type, input.types));
  }

  if (typeof input.lookingForContributors === 'boolean') {
    filters.push(eq(project.isLookingForContributors, input.lookingForContributors));
  }

  if (typeof input.lookingForInvestors === 'boolean') {
    filters.push(eq(project.isLookingForInvestors, input.lookingForInvestors));
  }

  if (typeof input.hiring === 'boolean') {
    filters.push(eq(project.isHiring, input.hiring));
  }

  if (typeof input.acquired === 'boolean') {
    filters.push(eq(project.hasBeenAcquired, input.acquired));
  }

  if (input.host) {
    filters.push(eq(project.gitHost, input.host));
  }

  return filters;
}

async function getPublicProjectForAction(ctx: { db: TRPCContext['db'] }, projectId: string) {
  const selectedProject = await ctx.db.query.project.findFirst({
    where: and(eq(project.id, projectId), isNull(project.deletedAt)),
  });

  if (
    !selectedProject ||
    selectedProject.approvalStatus !== 'approved' ||
    !selectedProject.isPublic
  ) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Project not found.',
    });
  }

  return selectedProject;
}

async function notifyProjectOwnerReview(
  ctx: { db: TRPCContext['db'] },
  reviewedProject: Project,
  action: 'approved' | 'rejected',
  reason?: string,
) {
  if (!reviewedProject.ownerId) return;

  const owner = await ctx.db.query.user.findFirst({
    where: eq(userTable.id, reviewedProject.ownerId),
    columns: {
      email: true,
    },
  });

  if (!owner?.email) return;

  const isApproved = action === 'approved';

  try {
    await sendAuthEmail({
      to: owner.email,
      type: isApproved ? 'project-approved' : 'project-rejected',
      subject: isApproved
        ? `${reviewedProject.name} was approved on oss.now`
        : `${reviewedProject.name} needs changes before approval`,
      body: isApproved
        ? 'Your project was approved and is now visible in public discovery.'
        : `Your project was rejected by review. Reason: ${reason ?? 'No reason provided.'}`,
      actionText: isApproved ? 'View project' : 'Review project',
      actionUrl: isApproved
        ? `${env.WEB_BASE_URL}/projects/${reviewedProject.id}`
        : `${env.WEB_BASE_URL}/dashboard/projects`,
    });
  } catch (error) {
    console.error('Failed to send project review email:', error);
  }
}

export interface DebugPermissionsResult {
  currentUser: string;
  repoOwner: string;
  repoOwnerType: string;
  isDirectOwner: boolean;
  repoPermission?: string;
  repoPermissionDetails?: {
    permission: string;
    user?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
  repoPermissionError?: string;
  orgMembership?:
    | {
        role: string;
        state: string;
      }
    | string;
  orgMembershipError?: string;
}

async function verifyGitHubOwnership(
  github: Octokit & Api,
  owner: string,
  repo: string,
  ctx: VerifyGitHubOwnershipContext,
  input: { projectId: string },
): Promise<{ success: boolean; project: Project; ownershipType: string; verifiedAs: string }> {
  const { data: currentUser } = await github.rest.users.getAuthenticated();

  const { data: repoData } = await github.rest.repos.get({
    owner,
    repo,
  });

  let isOwner = false;
  let ownershipType = '';

  if (repoData.owner.login === currentUser.login) {
    isOwner = true;
    ownershipType = 'repository owner';
  } else if (repoData.owner.type === 'Organization') {
    console.log(`Checking org ownership for ${currentUser.login} in org ${repoData.owner.login}`);

    try {
      const { data: repoPermissions } = await github.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: currentUser.login,
      });

      console.log(
        `User ${currentUser.login} has ${repoPermissions.permission} permission on the repository`,
      );

      if (repoPermissions.permission === 'admin') {
        try {
          const { data: membership } = await github.rest.orgs.getMembershipForUser({
            org: repoData.owner.login,
            username: currentUser.login,
          });

          console.log(
            `User ${currentUser.login} has role '${membership.role}' in org with state '${membership.state}'`,
          );

          if (membership.role === 'admin' && membership.state === 'active') {
            isOwner = true;
            ownershipType = 'organization owner';
          }
        } catch (orgError) {
          console.log('Error checking org membership:', orgError);
          isOwner = true;
          ownershipType = 'repository admin';
        }
      }
    } catch (error: unknown) {
      console.log(
        'User does not have collaborator access to the repository:',
        (error as Error).message,
      );

      try {
        const { data: membership } = await github.rest.orgs.getMembershipForUser({
          org: repoData.owner.login,
          username: currentUser.login,
        });

        if (membership.role === 'admin' && membership.state === 'active') {
          isOwner = true;
          ownershipType = 'organization owner';
        }
      } catch (orgError) {
        console.log('User is not a member of the organization');
      }
    }
  }

  if (!isOwner) {
    console.log(`Claim denied for user ${currentUser.login} on repo ${owner}/${repo}`);
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You don't have the required permissions to claim this project. You must be either the repository owner or an organization owner. Current user: ${currentUser.login}, Repository owner: ${repoData.owner.login}`,
    });
  }

  console.log(`Claim approved: ${currentUser.login} is ${ownershipType} for ${owner}/${repo}`);

  const updatedProject = await ctx.db
    .update(project)
    .set({
      ownerId: ctx.session.userId,
      updatedAt: new Date(),
    })
    .where(eq(project.id, input.projectId))
    .returning();

  if (!updatedProject[0]) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update project ownership',
    });
  }

  // Create a notification or send an email to inform about the claim
  // This would require implementing a notification system
  // Example: await createNotification({
  //   type: 'project_claimed',
  //   projectId: input.projectId,
  //   newOwnerId: ctx.session.userId,
  // });

  return {
    success: true,
    project: updatedProject[0],
    ownershipType,
    verifiedAs: currentUser.login,
  };
}

export const projectsRouter = createTRPCRouter({
  getProjects: publicProcedure
    .input(projectDiscoveryInput.optional().default({}))
    .query(async ({ ctx, input }) => {
      const isAdmin = ctx.user?.role === 'admin';
      const approvalStatus = input.approvalStatus ?? 'approved';

      if (!isAdmin && approvalStatus !== 'approved') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only admins can request non-public project review states.',
        });
      }

      const filters = buildProjectDiscoveryFilters(input, isAdmin);
      const rows = await ctx.db
        .select({
          project,
          githubStats: projectGithubStats,
        })
        .from(project)
        .leftJoin(projectGithubStats, eq(projectGithubStats.projectId, project.id))
        .where(and(...filters))
        .orderBy(desc(project.createdAt));
      const projects = await attachFreshGithubStats(ctx, rows);

      return sortProjects(projects, input.sort ?? 'relevance', input.search);
    }),
  getProject: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select({
        project,
        githubStats: projectGithubStats,
      })
      .from(project)
      .leftJoin(projectGithubStats, eq(projectGithubStats.projectId, project.id))
      .where(eq(project.id, input.id))
      .limit(1);

    if (!row?.project || row.project.deletedAt) {
      return null;
    }

    const selectedProject = row.project;
    const canView =
      (selectedProject.approvalStatus === 'approved' && selectedProject.isPublic) ||
      selectedProject.ownerId === ctx.session?.userId ||
      ctx.user?.role === 'admin';

    if (!canView) return null;

    const [freshProject] = await attachFreshGithubStats(ctx, [row]);
    return freshProject ?? null;
  }),
  getMyProjects: protectedProcedure.query(({ ctx }) => {
    return ctx.db.query.project.findMany({
      where: and(eq(project.ownerId, ctx.user.id), isNull(project.deletedAt)),
      orderBy: [desc(project.createdAt)],
    });
  }),
  createProject: protectedProcedure.input(projectInput).mutation(async ({ ctx, input }) => {
    await requireOwnerAccount(ctx);

    const normalizedRepo = parseGitHubRepoName(input.gitRepoUrl);
    const projectValues = {
      ...input,
      gitRepoUrl: normalizedRepo.fullName,
    };

    const existingProject = await ctx.db.query.project.findFirst({
      where: eq(project.gitRepoUrl, normalizedRepo.fullName),
    });

    if (existingProject) {
      if (existingProject.ownerId && existingProject.ownerId !== ctx.user.id) {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'This repository has already been submitted by another account. If you own it, use the project claim flow or contact support.',
        });
      }

      if (!existingProject.ownerId) {
        await requireLinkedGitHubAccount(ctx);

        const github = await createOctokitInstance(ctx);
        await verifyGitHubOwnership(
          github,
          normalizedRepo.owner,
          normalizedRepo.repo,
          {
            db: ctx.db,
            session: { userId: ctx.user.id },
          },
          {
            projectId: existingProject.id,
          },
        );
      }

      return ctx.db
        .update(project)
        .set({
          ...projectValues,
          ownerId: ctx.user.id,
          approvalStatus: 'pending',
          rejectionReason: null,
          reviewedById: null,
          reviewedAt: null,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(project.id, existingProject.id))
        .returning();
    }

    return ctx.db
      .insert(project)
      .values({
        ...projectValues,
        ownerId: ctx.user.id,
        approvalStatus: 'pending',
        rejectionReason: null,
        reviewedById: null,
        reviewedAt: null,
      })
      .returning();
  }),
  addProject: protectedProcedure.input(projectInput).mutation(async ({ ctx, input }) => {
    await requireOwnerAccount(ctx);

    const normalizedRepo = parseGitHubRepoName(input.gitRepoUrl);
    await ensureRepoIdentityIsAvailable(ctx, normalizedRepo.fullName);

    return ctx.db
      .insert(project)
      .values({
        ...input,
        gitRepoUrl: normalizedRepo.fullName,
        ownerId: ctx.user.id,
        approvalStatus: 'pending',
        rejectionReason: null,
        reviewedById: null,
        reviewedAt: null,
      })
      .returning();
  }),
  updateMyProject: protectedProcedure.input(updateMyProjectInput).mutation(async ({ ctx, input }) => {
    await requireOwnerAccount(ctx);

    const { id, ...updates } = input;
    const normalizedRepo = updates.gitRepoUrl ? parseGitHubRepoName(updates.gitRepoUrl) : null;

    const existingProject = await ctx.db.query.project.findFirst({
      where: and(eq(project.id, id), eq(project.ownerId, ctx.user.id), isNull(project.deletedAt)),
    });

    if (!existingProject) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Project not found or you do not have permission to edit it.',
      });
    }

    if (normalizedRepo) {
      await ensureRepoIdentityIsAvailable(ctx, normalizedRepo.fullName, id);
    }

    const shouldPullFromPublicReview = existingProject.approvalStatus !== 'pending';
    const updatedProjects = await ctx.db
      .update(project)
      .set({
        ...updates,
        ...(normalizedRepo ? { gitRepoUrl: normalizedRepo.fullName } : {}),
        approvalStatus: 'pending',
        rejectionReason: null,
        reviewedById: null,
        reviewedAt: null,
        ...(shouldPullFromPublicReview ? { isPublic: false } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(project.id, id), eq(project.ownerId, ctx.user.id), isNull(project.deletedAt)))
      .returning();

    if (!updatedProjects[0]) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Project not found or you do not have permission to edit it.',
      });
    }

    return updatedProjects;
  }),
  resubmitMyProject: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccount(ctx);

      const resubmittedProjects = await ctx.db
        .update(project)
        .set({
          approvalStatus: 'pending',
          isPublic: false,
          rejectionReason: null,
          reviewedById: null,
          reviewedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(project.id, input.id), eq(project.ownerId, ctx.user.id), isNull(project.deletedAt)))
        .returning();

      if (!resubmittedProjects[0]) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Project not found or you do not have permission to resubmit it.',
        });
      }

      return resubmittedProjects;
    }),
  updateProject: protectedProcedure.input(updateMyProjectInput).mutation(async ({ ctx, input }) => {
    await requireOwnerAccount(ctx);

    const { id, ...updates } = input;
    const normalizedRepo = updates.gitRepoUrl ? parseGitHubRepoName(updates.gitRepoUrl) : null;
    const existingProject = await ctx.db.query.project.findFirst({
      where: and(eq(project.id, id), eq(project.ownerId, ctx.user.id), isNull(project.deletedAt)),
    });

    if (!existingProject) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Project not found or you do not have permission to edit it.',
      });
    }

    if (normalizedRepo) {
      await ensureRepoIdentityIsAvailable(ctx, normalizedRepo.fullName, id);
    }

    const shouldPullFromPublicReview = existingProject.approvalStatus !== 'pending';
    const updatedProjects = await ctx.db
      .update(project)
      .set({
        ...updates,
        ...(normalizedRepo ? { gitRepoUrl: normalizedRepo.fullName } : {}),
        approvalStatus: 'pending',
        rejectionReason: null,
        reviewedById: null,
        reviewedAt: null,
        ...(shouldPullFromPublicReview ? { isPublic: false } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(project.id, id), eq(project.ownerId, ctx.user.id), isNull(project.deletedAt)))
      .returning();

    if (!updatedProjects[0]) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Project not found or you do not have permission to edit it.',
      });
    }

    return updatedProjects;
  }),
  acceptProject: adminProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const reviewedAt = new Date();
      const updatedProject = await ctx.db.transaction(async (tx) => {
        const [reviewedProject] = await tx
          .update(project)
          .set({
            approvalStatus: 'approved',
            isPublic: true,
            rejectionReason: null,
            reviewedById: ctx.user.id,
            reviewedAt,
            updatedAt: reviewedAt,
          })
          .where(eq(project.id, input.projectId))
          .returning();

        if (!reviewedProject) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Project not found.',
          });
        }

        await tx.insert(projectReviewEvent).values({
          projectId: input.projectId,
          adminId: ctx.user.id,
          action: 'approved',
          reason: null,
          metadata: {
            isPublic: true,
          },
        });

        return reviewedProject;
      });

      await notifyProjectOwnerReview(ctx, updatedProject, 'approved');

      return [updatedProject];
    }),
  rejectProject: adminProcedure
    .input(
      z.object({
        projectId: z.string(),
        reason: z.string().trim().min(10).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const reviewedAt = new Date();
      const reason = input.reason.trim();
      const updatedProject = await ctx.db.transaction(async (tx) => {
        const [reviewedProject] = await tx
          .update(project)
          .set({
            approvalStatus: 'rejected',
            isPublic: false,
            rejectionReason: reason,
            reviewedById: ctx.user.id,
            reviewedAt,
            updatedAt: reviewedAt,
          })
          .where(eq(project.id, input.projectId))
          .returning();

        if (!reviewedProject) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Project not found.',
          });
        }

        await tx.insert(projectReviewEvent).values({
          projectId: input.projectId,
          adminId: ctx.user.id,
          action: 'rejected',
          reason,
          metadata: {
            isPublic: false,
          },
        });

        return reviewedProject;
      });

      await notifyProjectOwnerReview(ctx, updatedProject, 'rejected', reason);

      return [updatedProject];
    }),
  getProjectReviewEvents: adminProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => {
      return ctx.db.query.projectReviewEvent.findMany({
        where: eq(projectReviewEvent.projectId, input.projectId),
        orderBy: [desc(projectReviewEvent.createdAt)],
      });
    }),
  getAdminProjectDetail: adminProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({
          project,
          githubStats: projectGithubStats,
        })
        .from(project)
        .leftJoin(projectGithubStats, eq(projectGithubStats.projectId, project.id))
        .where(eq(project.id, input.projectId))
        .limit(1);

      if (!row?.project) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Project not found.',
        });
      }

      const [selectedProject] = await attachFreshGithubStats(ctx, [row]);
      const currentProject = selectedProject ?? { ...row.project, githubStats: row.githubStats };
      const userIds = [
        currentProject.ownerId,
        currentProject.reviewedById,
      ].filter((value): value is string => Boolean(value));
      const [users, reviewEvents, interests, reports] = await Promise.all([
        userIds.length
          ? ctx.db
              .select({
                id: userTable.id,
                name: userTable.name,
                email: userTable.email,
                image: userTable.image,
                role: userTable.role,
                accountType: userTable.accountType,
              })
              .from(userTable)
              .where(inArray(userTable.id, userIds))
          : [],
        ctx.db
          .select({
            event: projectReviewEvent,
            admin: {
              id: userTable.id,
              name: userTable.name,
              email: userTable.email,
            },
          })
          .from(projectReviewEvent)
          .innerJoin(userTable, eq(projectReviewEvent.adminId, userTable.id))
          .where(eq(projectReviewEvent.projectId, input.projectId))
          .orderBy(desc(projectReviewEvent.createdAt)),
        ctx.db
          .select({
            interest: projectInterest,
            user: {
              id: userTable.id,
              name: userTable.name,
              email: userTable.email,
              image: userTable.image,
              accountType: userTable.accountType,
            },
          })
          .from(projectInterest)
          .innerJoin(userTable, eq(projectInterest.userId, userTable.id))
          .where(eq(projectInterest.projectId, input.projectId))
          .orderBy(desc(projectInterest.createdAt)),
        ctx.db
          .select({
            report: projectReport,
            user: {
              id: userTable.id,
              name: userTable.name,
              email: userTable.email,
            },
          })
          .from(projectReport)
          .leftJoin(userTable, eq(projectReport.userId, userTable.id))
          .where(eq(projectReport.projectId, input.projectId))
          .orderBy(desc(projectReport.createdAt)),
      ]);
      const userById = new Map(users.map((selectedUser) => [selectedUser.id, selectedUser]));

      return {
        project: currentProject,
        owner: currentProject.ownerId ? (userById.get(currentProject.ownerId) ?? null) : null,
        reviewer: currentProject.reviewedById
          ? (userById.get(currentProject.reviewedById) ?? null)
          : null,
        claimStatus: {
          claimed: Boolean(currentProject.ownerId),
          ownerId: currentProject.ownerId,
        },
        reviewEvents,
        interests,
        reports,
      };
    }),
  deleteMyProject: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccount(ctx);

      const deletedProjects = await ctx.db
        .update(project)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(project.id, input.id), eq(project.ownerId, ctx.user.id)))
        .returning();

      if (!deletedProjects[0]) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Project not found or you do not have permission to delete it.',
        });
      }

      return deletedProjects;
    }),
  deleteProject: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccount(ctx);

      const deletedProjects = await ctx.db
        .update(project)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(project.id, input.id), eq(project.ownerId, ctx.user.id)))
        .returning();

      if (!deletedProjects[0]) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Project not found or you do not have permission to delete it.',
        });
      }

      return deletedProjects;
    }),
  claimProject: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const github = await createOctokitInstance(ctx);

      // 1. Get the project details
      const projectToClaim = await ctx.db.query.project.findFirst({
        where: eq(project.id, input.projectId),
      });

      if (!projectToClaim) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Project not found',
        });
      }

      if (projectToClaim.ownerId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This project has already been claimed',
        });
      }

      if (!projectToClaim.gitRepoUrl) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This project does not have a GitHub repository URL',
        });
      }

      const userId = ctx.session.userId;
      if (!userId) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You must be logged in to claim a project',
        });
      }

      const userAccount = await ctx.db
        .select({ accessToken: account.accessToken })
        .from(account)
        .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
        .limit(1);

      if (!userAccount[0]?.accessToken) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Please connect your GitHub account to claim this project',
        });
      }

      const { owner, repo } = parseGitHubRepoName(projectToClaim.gitRepoUrl);

      try {
        if (!ctx.session?.userId) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Session not found or invalid',
          });
        }

        const verifyContext: VerifyGitHubOwnershipContext = {
          db: ctx.db,
          session: { userId: ctx.session.userId },
        };

        const result = await verifyGitHubOwnership(github, owner, repo, verifyContext, input);
        return result;
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        console.error('GitHub API error:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to verify GitHub ownership. Please try again.',
        });
      }
    }),
  canClaimProject: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const projectToCheck = await ctx.db.query.project.findFirst({
        where: eq(project.id, input.projectId),
      });

      if (!projectToCheck) {
        return { canClaim: false, reason: 'Project not found' };
      }

      const canPreviewClaim =
        (projectToCheck.approvalStatus === 'approved' && projectToCheck.isPublic) ||
        ctx.user.role === 'admin';

      if (!canPreviewClaim) {
        return { canClaim: false, reason: 'Project not found' };
      }

      if (projectToCheck.ownerId) {
        return { canClaim: false, reason: 'Project already claimed' };
      }

      if (!projectToCheck.gitRepoUrl) {
        return { canClaim: false, reason: 'No GitHub repository URL' };
      }

      const userId = ctx.session.userId;
      if (!userId) {
        return { canClaim: false, reason: 'Not logged in' };
      }

      const userAccount = await ctx.db
        .select({ accessToken: account.accessToken })
        .from(account)
        .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
        .limit(1);

      if (!userAccount[0]?.accessToken) {
        return {
          canClaim: false,
          reason: 'GitHub account not connected',
          needsGitHubAuth: true,
        };
      }

      return {
        canClaim: true,
        projectName: projectToCheck.name,
        gitRepoUrl: projectToCheck.gitRepoUrl,
      };
    }),
  getSavedProjects: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        project,
        githubStats: projectGithubStats,
        savedAt: savedProject.createdAt,
      })
      .from(savedProject)
      .innerJoin(project, eq(savedProject.projectId, project.id))
      .leftJoin(projectGithubStats, eq(projectGithubStats.projectId, project.id))
      .where(
        and(
          eq(savedProject.userId, ctx.user.id),
          isNull(project.deletedAt),
          eq(project.approvalStatus, 'approved'),
          eq(project.isPublic, true),
        ),
      )
      .orderBy(desc(savedProject.createdAt));
    const savedAtByProjectId = new Map(rows.map((row) => [row.project.id, row.savedAt]));
    const projects = await attachFreshGithubStats(ctx, rows);

    return projects.map((selectedProject) => ({
      project: selectedProject,
      savedAt: savedAtByProjectId.get(selectedProject.id) ?? selectedProject.createdAt,
    }));
  }),
  getMyProjectInterestHistory: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        interest: projectInterest,
        project,
        githubStats: projectGithubStats,
      })
      .from(projectInterest)
      .innerJoin(project, eq(projectInterest.projectId, project.id))
      .leftJoin(projectGithubStats, eq(projectGithubStats.projectId, project.id))
      .where(and(eq(projectInterest.userId, ctx.user.id), isNull(project.deletedAt)))
      .orderBy(desc(projectInterest.createdAt));
    const projects = await attachFreshGithubStats(
      ctx,
      rows.map((row) => ({ project: row.project, githubStats: row.githubStats })),
    );
    const projectById = new Map(projects.map((selectedProject) => [selectedProject.id, selectedProject]));

    return rows.map((row) => ({
      interest: row.interest,
      project: projectById.get(row.project.id) ?? { ...row.project, githubStats: row.githubStats },
    }));
  }),
  getRecommendedProjects: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(24).default(6) }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 6;
      const currentUser = await ctx.db.query.user.findFirst({
        where: eq(userTable.id, ctx.user.id),
        columns: {
          accountType: true,
        },
      });

      if (currentUser?.accountType !== 'contributor' && currentUser?.accountType !== 'investor') {
        return [];
      }

      const filters = [
        isNull(project.deletedAt),
        eq(project.approvalStatus, 'approved'),
        eq(project.isPublic, true),
        sql`${project.ownerId} is distinct from ${ctx.user.id}`,
      ];

      if (currentUser.accountType === 'contributor') {
        filters.push(eq(project.isLookingForContributors, true));
      }

      if (currentUser.accountType === 'investor') {
        filters.push(eq(project.isLookingForInvestors, true));
      }

      const rows = await ctx.db
        .select({
          project,
          githubStats: projectGithubStats,
        })
        .from(project)
        .leftJoin(projectGithubStats, eq(projectGithubStats.projectId, project.id))
        .where(and(...filters))
        .orderBy(desc(project.createdAt))
        .limit(48);
      const projects = await attachFreshGithubStats(ctx, rows);

      if (currentUser.accountType === 'contributor') {
        const profile = await ctx.db.query.contributorProfile.findFirst({
          where: eq(contributorProfile.userId, ctx.user.id),
        });

        return [...projects]
          .sort(
            (a, b) =>
              scoreContributorRecommendation(b, profile) -
              scoreContributorRecommendation(a, profile),
          )
          .slice(0, limit);
      }

      const profile = await ctx.db.query.investorProfile.findFirst({
        where: eq(investorProfile.userId, ctx.user.id),
      });

      return [...projects]
        .sort(
          (a, b) =>
            scoreInvestorRecommendation(b, profile) - scoreInvestorRecommendation(a, profile),
        )
        .slice(0, limit);
    }),
  getProjectViewerState: publicProcedure.input(projectViewerInput).query(async ({ ctx, input }) => {
    const userId = ctx.user?.id;

    if (!userId) {
      return {
        isSaved: false,
        interestTypes: [] as Array<'contribution' | 'investment' | 'contact'>,
        hasReported: false,
      };
    }

    const [saved, interests, reports] = await Promise.all([
      ctx.db
        .select({ id: savedProject.id })
        .from(savedProject)
        .where(and(eq(savedProject.projectId, input.projectId), eq(savedProject.userId, userId)))
        .limit(1),
      ctx.db
        .select({ type: projectInterest.type })
        .from(projectInterest)
        .where(and(eq(projectInterest.projectId, input.projectId), eq(projectInterest.userId, userId))),
      ctx.db
        .select({ id: projectReport.id })
        .from(projectReport)
        .where(and(eq(projectReport.projectId, input.projectId), eq(projectReport.userId, userId)))
        .limit(1),
    ]);

    return {
      isSaved: Boolean(saved[0]),
      interestTypes: interests.map((interest) => interest.type),
      hasReported: Boolean(reports[0]),
    };
  }),
  saveProject: protectedProcedure.input(projectViewerInput).mutation(async ({ ctx, input }) => {
    await getPublicProjectForAction(ctx, input.projectId);

    const [saved] = await ctx.db
      .insert(savedProject)
      .values({
        projectId: input.projectId,
        userId: ctx.user.id,
      })
      .onConflictDoNothing({
        target: [savedProject.projectId, savedProject.userId],
      })
      .returning();

    return saved ?? { projectId: input.projectId, userId: ctx.user.id };
  }),
  unsaveProject: protectedProcedure.input(projectViewerInput).mutation(async ({ ctx, input }) => {
    await ctx.db
      .delete(savedProject)
      .where(and(eq(savedProject.projectId, input.projectId), eq(savedProject.userId, ctx.user.id)));

    return { success: true };
  }),
  expressProjectInterest: protectedProcedure
    .input(projectInterestInput)
    .mutation(async ({ ctx, input }) => {
      const selectedProject = await getPublicProjectForAction(ctx, input.projectId);

      if (selectedProject.ownerId === ctx.user.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Owners cannot send interest to their own projects.',
        });
      }

      const currentUser = await ctx.db.query.user.findFirst({
        where: eq(userTable.id, ctx.user.id),
        columns: {
          accountType: true,
        },
      });

      if (input.type === 'contribution' && currentUser?.accountType !== 'contributor') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Switch to a contributor account before sending contributor interest.',
        });
      }

      if (input.type === 'investment' && currentUser?.accountType !== 'investor') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Switch to an investor account before sending investor interest.',
        });
      }

      if (input.type === 'contact' && !selectedProject.ownerId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This project has not been claimed by a maintainer yet.',
        });
      }

      const now = new Date();
      const [interest] = await ctx.db
        .insert(projectInterest)
        .values({
          projectId: input.projectId,
          userId: ctx.user.id,
          type: input.type,
          message: input.message?.trim() || null,
          status: 'new',
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [projectInterest.projectId, projectInterest.userId, projectInterest.type],
          set: {
            message: input.message?.trim() || null,
            status: 'new',
            updatedAt: now,
          },
        })
        .returning();

      if (!interest) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Could not create project interest.',
        });
      }

      return interest;
    }),
  reportProject: protectedProcedure.input(projectReportInput).mutation(async ({ ctx, input }) => {
    await getPublicProjectForAction(ctx, input.projectId);

    const [report] = await ctx.db
      .insert(projectReport)
      .values({
        projectId: input.projectId,
        userId: ctx.user.id,
        reason: input.reason.trim(),
        details: input.details?.trim() || null,
      })
      .returning();

    if (!report) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Could not create project report.',
      });
    }

    return report;
  }),
  getMyProjectInterestInbox: protectedProcedure.query(async ({ ctx }) => {
    await requireOwnerAccount(ctx);

    return ctx.db
      .select({
        interest: projectInterest,
        project: {
          id: project.id,
          name: project.name,
          gitRepoUrl: project.gitRepoUrl,
          approvalStatus: project.approvalStatus,
        },
        user: {
          id: userTable.id,
          name: userTable.name,
          email: userTable.email,
          image: userTable.image,
          accountType: userTable.accountType,
        },
      })
      .from(projectInterest)
      .innerJoin(project, eq(projectInterest.projectId, project.id))
      .innerJoin(userTable, eq(projectInterest.userId, userTable.id))
      .where(and(eq(project.ownerId, ctx.user.id), isNull(project.deletedAt)))
      .orderBy(desc(projectInterest.createdAt));
  }),

  debugGitHubPermissions: protectedProcedure
    .input(z.object({ repoUrl: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.userId;
      if (!userId) {
        return { error: 'Not logged in' };
      }

      const userAccount = await ctx.db
        .select({ accessToken: account.accessToken })
        .from(account)
        .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
        .limit(1);

      if (!userAccount[0]?.accessToken) {
        return { error: 'GitHub account not connected' };
      }

      const githubUrlRegex = /(?:https?:\/\/github\.com\/|^)([^\/]+)\/([^\/]+?)(?:\.git|\/|$)/;
      const match = input.repoUrl.match(githubUrlRegex);
      if (!match) {
        return { error: 'Invalid GitHub repository URL format' };
      }
      const [, owner, repo] = match;

      const github = await createOctokitInstance(ctx);

      if (!owner || !repo) {
        return { error: 'Invalid repository format' };
      }

      try {
        const { data: currentUser } = await github.rest.users.getAuthenticated();
        const { data: repoData } = await github.rest.repos.get({
          owner,
          repo,
        });

        const result: DebugPermissionsResult = {
          currentUser: currentUser.login,
          repoOwner: repoData.owner.login,
          repoOwnerType: repoData.owner.type,
          isDirectOwner: repoData.owner.login === currentUser.login,
        };

        try {
          const { data: repoPermissions } = await github.rest.repos.getCollaboratorPermissionLevel({
            owner,
            repo,
            username: currentUser.login,
          });
          result.repoPermission = repoPermissions.permission;
          result.repoPermissionDetails = repoPermissions;
        } catch (e: unknown) {
          result.repoPermission = 'none';
          result.repoPermissionError = (e as Error).message;
        }

        if (repoData.owner.type === 'Organization') {
          try {
            const { data: membership } = await github.rest.orgs.getMembershipForUser({
              org: repoData.owner.login,
              username: currentUser.login,
            });
            result.orgMembership = {
              role: membership.role,
              state: membership.state,
            };
          } catch (e: unknown) {
            result.orgMembership = 'not a member';
            result.orgMembershipError = (e as Error).message;
          }
        }

        return result;
      } catch (error: unknown) {
        return { error: (error as Error).message };
      }
    }),
});
