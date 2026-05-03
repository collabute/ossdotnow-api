import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { createTRPCRouter, publicProcedure } from '../trpc.js';
import { generateText, Output } from 'ai';
import { openai } from '@ai-sdk/openai';
import { account } from '../db/schema/index.js';
import { TRPCError } from '@trpc/server';
import { env } from '../env/server.js';
import { Octokit } from '@octokit/core';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod/v4';

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

const repoSearchInput = z.object({
  query: z.string().trim().min(2).max(80),
});

const repoInput = z.object({
  repo: z.string().trim().min(1).max(120),
});

const projectSuggestionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  status: z.enum(projectStatuses),
  type: z.enum(projectTypes),
  tags: z.array(z.enum(projectTags)).max(5),
  isLookingForContributors: z.boolean(),
  isHiring: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(300),
});

function parseRepoName(input: string) {
  const trimmed = input.trim();
  const withoutUrl = trimmed
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const [owner, repo] = withoutUrl.split('/');

  if (!owner || !repo || owner.includes(' ') || repo.includes(' ')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid repository format. Use owner/repository.',
    });
  }

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
  };
}

function mapRepo(repo: any) {
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description ?? '',
    htmlUrl: repo.html_url,
    homepage: repo.homepage ?? '',
    language: repo.language ?? '',
    topics: repo.topics ?? [],
    stargazersCount: repo.stargazers_count ?? 0,
    forksCount: repo.forks_count ?? 0,
    openIssuesCount: repo.open_issues_count ?? 0,
    pushedAt: repo.pushed_at ?? '',
    owner: {
      login: repo.owner?.login ?? '',
      avatarUrl: repo.owner?.avatar_url ?? '',
      htmlUrl: repo.owner?.html_url ?? '',
    },
  };
}

function titleizeRepoName(name: string) {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function inferFallbackSuggestions(repo: ReturnType<typeof mapRepo>) {
  const searchable = [
    repo.name,
    repo.description,
    repo.language,
    ...repo.topics,
  ]
    .join(' ')
    .toLowerCase();

  const tags = new Set<(typeof projectTags)[number]>();
  const addTag = (tag: (typeof projectTags)[number]) => {
    if (tags.size < 5) tags.add(tag);
  };

  if (/react|vue|svelte|next|vite|css|tailwind|ui|frontend/.test(searchable)) addTag('frontend');
  if (/api|server|database|postgres|worker|backend|go|rust/.test(searchable)) addTag('backend');
  if (/mobile|ios|android|react native|swift|kotlin/.test(searchable)) addTag('mobile');
  if (/ai|llm|agent|openai|machine learning|ml/.test(searchable)) addTag('ai');
  if (/data|analytics|warehouse|etl|dataset/.test(searchable)) addTag('data-analysis');
  if (/game|unity|engine|graphics/.test(searchable)) addTag('game');
  if (/crypto|web3|blockchain|wallet/.test(searchable)) addTag('crypto');
  if (tags.size === 0) addTag('web');
  if (tags.size < 2 && /typescript|javascript|node/.test(searchable)) addTag('fullstack');

  const type: (typeof projectTypes)[number] = /dev|sdk|cli|tool|framework|library|api/.test(
    searchable,
  )
    ? 'developer-tools'
    : /analytics|data/.test(searchable)
      ? 'analytics'
      : /content|cms|docs|blog/.test(searchable)
        ? 'content-management'
        : /commerce|shop|store/.test(searchable)
          ? 'ecommerce'
          : /social|community|chat/.test(searchable)
            ? 'social'
            : /productivity|task|calendar|notes/.test(searchable)
              ? 'productivity'
              : 'other';

  const pushedAt = repo.pushedAt ? new Date(repo.pushedAt).getTime() : 0;
  const daysSincePush = pushedAt ? (Date.now() - pushedAt) / 86_400_000 : Number.POSITIVE_INFINITY;

  return {
    name: titleizeRepoName(repo.name),
    description:
      repo.description ||
      `${titleizeRepoName(repo.name)} is an open source project maintained by ${repo.owner.login}.`,
    status: daysSincePush < 120 ? ('active' as const) : ('inactive' as const),
    type,
    tags: Array.from(tags),
    isLookingForContributors: repo.openIssuesCount > 0,
    isHiring: false,
    confidence: 0.45,
    rationale: 'Generated from repository metadata because AI suggestions are unavailable.',
  };
}

export async function createOctokitInstance(ctx: any) {
  const MyOctokit = Octokit.plugin(restEndpointMethods);

  if (ctx.user?.id) {
    const userAccount = await ctx.db
      .select({ accessToken: account.accessToken })
      .from(account)
      .where(and(eq(account.userId, ctx.user.id), eq(account.providerId, 'github')))
      .limit(1);

    if (userAccount[0]?.accessToken) {
      return new MyOctokit({ auth: userAccount[0].accessToken });
    }
  }

  return new MyOctokit({ auth: env.GITHUB_TOKEN });
}

export const githubRouter = createTRPCRouter({
  searchRepos: publicProcedure.input(repoSearchInput).query(async ({ input, ctx }) => {
    const github = await createOctokitInstance(ctx);
    const trimmedQuery = input.query.trim();
    const searchQuery = trimmedQuery.includes('/')
      ? `${trimmedQuery} in:name,full_name`
      : `${trimmedQuery} in:name,full_name,description`;

    try {
      const result = await github.rest.search.repos({
        q: searchQuery,
        per_page: 8,
      });

      return {
        repositories: result.data.items.map(mapRepo),
      };
    } catch (error) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Could not search GitHub repositories. Please try a different query.',
        cause: error,
      });
    }
  }),

  suggestProjectFields: publicProcedure.input(repoInput).mutation(async ({ input, ctx }) => {
    const { owner, repo } = parseRepoName(input.repo);

    const github = await createOctokitInstance(ctx);

    const [repoData, topicsData] = await Promise.all([
      github.rest.repos.get({ owner, repo }),
      github.rest.repos.getAllTopics({ owner, repo }).catch(() => ({ data: { names: [] } })),
    ]);

    const normalizedRepo = mapRepo({
      ...repoData.data,
      topics: repoData.data.topics?.length ? repoData.data.topics : topicsData.data.names,
    });

    const fallback = inferFallbackSuggestions(normalizedRepo);

    if (!env.OPENAI_API_KEY) {
      return {
        source: 'heuristic' as const,
        repo: normalizedRepo,
        suggestions: fallback,
      };
    }

    try {
      const { output } = await generateText({
        model: openai.responses('gpt-5.4-mini'),
        output: Output.object({
          schema: projectSuggestionSchema,
        }),
        maxOutputTokens: 900,
        system:
          'You classify open source repositories for oss.now project submissions. Use only the allowed enum values. Prefer practical categories over marketing language. Keep descriptions concise and user-editable.',
        prompt: JSON.stringify({
          repository: normalizedRepo,
          allowedStatuses: projectStatuses,
          allowedTypes: projectTypes,
          allowedTags: projectTags,
          task:
            'Suggest form fields for this repository. Pick one type, one status, up to five tags, and whether the project appears to need contributors or hiring.',
        }),
      });

      return {
        source: 'ai' as const,
        repo: normalizedRepo,
        suggestions: output,
      };
    } catch (error) {
      return {
        source: 'heuristic' as const,
        repo: normalizedRepo,
        suggestions: fallback,
        warning: 'AI suggestions failed, so repository metadata was used instead.',
      };
    }
  }),

  getRepo: publicProcedure.input(repoInput).query(async ({ input, ctx }) => {
    const { owner, repo } = parseRepoName(input.repo);

    const github = await createOctokitInstance(ctx);

    const repoData = await github.rest.repos.get({
      owner,
      repo,
    });

    return repoData.data;
  }),
  getContributors: publicProcedure
    .input(z.object({ repo: z.string() }))
    .query(async ({ input, ctx }) => {
      const [owner, repo] = input.repo.split('/');

      if (!owner || !repo) {
        throw new Error('Invalid repository format. Use: username/repository');
      }

      const github = await createOctokitInstance(ctx);

      const contributors = await github.rest.repos.listContributors({
        owner,
        repo,
      });

      return contributors.data;
    }),

  getIssues: publicProcedure.input(z.object({ repo: z.string() })).query(async ({ input, ctx }) => {
    const [owner, repo] = input.repo.split('/');

    if (!owner || !repo) {
      throw new Error('Invalid repository format. Use: username/repository');
    }

    const github = await createOctokitInstance(ctx);

    const issues = await github.rest.issues.listForRepo({
      owner,
      repo,
      state: 'all',
      per_page: 100,
    });

    return issues.data;
  }),
  getPullRequests: publicProcedure
    .input(z.object({ repo: z.string() }))
    .query(async ({ input, ctx }) => {
      const [owner, repo] = input.repo.split('/');

      if (!owner || !repo) {
        throw new Error('Invalid repository format. Use: username/repository');
      }

      const github = await createOctokitInstance(ctx);

      const pullRequests = await github.rest.pulls.list({
        owner,
        repo,
        state: 'all',
        per_page: 100,
      });

      return pullRequests.data;
    }),

  // Batched endpoint that combines all GitHub API calls
  getRepoData: publicProcedure
    .input(z.object({ repo: z.string() }))
    .query(async ({ input, ctx }) => {
      const [owner, repo] = input.repo.split('/');

      if (!owner || !repo) {
        throw new Error('Invalid repository format. Use: username/repository');
      }

      const github = await createOctokitInstance(ctx);

      const [repoData, contributors, issues, pullRequests] = await Promise.all([
        github.rest.repos.get({ owner, repo }),
        github.rest.repos.listContributors({ owner, repo }),
        github.rest.issues.listForRepo({ owner, repo, state: 'all', per_page: 100 }),
        github.rest.pulls.list({ owner, repo, state: 'all', per_page: 100 }),
      ]);

      return {
        repo: repoData.data,
        contributors: contributors.data,
        issues: issues.data,
        pullRequests: pullRequests.data,
      };
    }),
});
