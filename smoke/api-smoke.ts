import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseGitHubRepoName } from '../src/utils/github-repo';

const root = new URL('../', import.meta.url);

async function read(path: string) {
  return readFile(new URL(path, root), 'utf8');
}

function includes(source: string, expected: string, message: string) {
  assert.ok(source.includes(expected), message);
}

const [server, envServer, readiness, projects, earlyAccess, earlySubmissions, projectSchema, trpc] =
  await Promise.all([
    read('src/server.ts'),
    read('src/env/server.ts'),
    read('src/utils/readiness.ts'),
    read('src/routers/projects.ts'),
    read('src/routers/early-access.ts'),
    read('src/routers/early-submissions.ts'),
    read('src/db/schema/projects.ts'),
    read('src/trpc.ts'),
  ]);

includes(server, "app.get('/healthz'", 'health endpoint is mounted');
includes(server, "app.get('/api/session'", 'session endpoint is mounted');
includes(server, "'/api/auth/*'", 'Better Auth endpoint is mounted');
includes(server, "'/api/trpc/*'", 'tRPC endpoint is mounted');
includes(server, "'/api/uploadthing'", 'UploadThing endpoint is mounted');
includes(server, 'getReadinessDiagnostics', 'health endpoint returns readiness diagnostics');

for (const envName of [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'RESEND_API_KEY',
  'AUTH_EMAIL_FROM',
  'UPLOADTHING_TOKEN',
  'OPENAI_API_KEY',
]) {
  includes(readiness, envName, `${envName} readiness is reported`);
}

for (const envName of [
  'DATABASE_URL',
  'API_BASE_URL',
  'WEB_BASE_URL',
  'CORS_ORIGINS',
  'AUTH_COOKIE_DOMAIN',
  'BETTER_AUTH_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'RESEND_API_KEY',
  'AUTH_EMAIL_FROM',
  'UNKEY_ROOT_KEY',
  'UPLOADTHING_TOKEN',
]) {
  includes(envServer, `'${envName}'`, `${envName} is production startup validated`);
}

includes(projects, 'createProject: protectedProcedure', 'project creation is authenticated');
includes(projects, 'getProjects: publicProcedure', 'public project discovery is exposed');
includes(projects, 'acceptProject: adminProcedure', 'project approval is admin-only');
includes(projects, 'rejectProject: adminProcedure', 'project rejection is admin-only');
includes(projects, 'claimProject: protectedProcedure', 'project claim is authenticated');
includes(projects, 'canClaimProject: protectedProcedure', 'claim eligibility is authenticated');
includes(projects, 'await requireOwnerAccount(ctx);', 'owner account guard is enforced');
includes(projects, 'ensureRepoIdentityIsAvailable', 'repo duplicates are checked defensively');
includes(projects, 'parseGitHubRepoName(input.gitRepoUrl)', 'project creation normalizes repo identity');
includes(projects, 'isNull(project.deletedAt)', 'soft-deleted projects are filtered from active reads');
includes(projectSchema, "gitRepoUrl: text('git_repo_url').unique().notNull()", 'repo identity has a DB unique constraint');
includes(trpc, "ctx.user.role !== 'admin'", 'admin procedures enforce admin role');

includes(earlyAccess, 'joinWaitlist: adminProcedure', 'early waitlist writes are admin-locked');
includes(
  earlySubmissions,
  'addProject: adminProcedure',
  'legacy early project submissions are admin-locked',
);
includes(
  earlySubmissions,
  'parseGitHubRepoName(input.gitRepoUrl)',
  'legacy early project submissions normalize repo identity',
);

assert.deepEqual(parseGitHubRepoName('https://github.com/Collabute/OssDotNow.git'), {
  owner: 'collabute',
  repo: 'ossdotnow',
  fullName: 'collabute/ossdotnow',
});
assert.deepEqual(parseGitHubRepoName('collabute/ossdotnow/tree/main'), {
  owner: 'collabute',
  repo: 'ossdotnow',
  fullName: 'collabute/ossdotnow',
});

console.log('API smoke checks passed');
