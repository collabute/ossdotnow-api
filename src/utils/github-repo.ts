import { TRPCError } from '@trpc/server';

const githubRepoSegmentPattern = /^[a-z0-9_.-]+$/;

export function parseGitHubRepoName(gitRepoUrl: string) {
  const normalizedInput = gitRepoUrl
    .trim()
    .replace(/^git\+/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github\.com\//i, '');

  if (!normalizedInput || normalizedInput.includes('://')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid GitHub repository format. Use owner/repository.',
    });
  }

  const repoPath = normalizedInput.split(/[?#]/)[0] ?? '';
  const [ownerRaw, repoRaw] = repoPath.split('/').filter(Boolean);
  const owner = ownerRaw?.toLowerCase();
  const repo = repoRaw?.replace(/\.git$/i, '').toLowerCase();

  if (
    !owner ||
    !repo ||
    !githubRepoSegmentPattern.test(owner) ||
    !githubRepoSegmentPattern.test(repo)
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid GitHub repository format. Use owner/repository.',
    });
  }

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
  };
}
