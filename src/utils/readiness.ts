import { env } from '../env/server.js';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

type ReadinessStatus = 'ready' | 'degraded' | 'missing';

type ProviderCheck = {
  configured: boolean;
  status: ReadinessStatus;
  missing: string[];
};

type DatabaseCheck = {
  reachable: boolean;
  status: ReadinessStatus;
  latencyMs?: number;
  error?: string;
};

function providerCheck(missing: string[], optional = false): ProviderCheck {
  const configured = missing.length === 0;

  return {
    configured,
    status: configured ? 'ready' : optional ? 'degraded' : 'missing',
    missing,
  };
}

export function getProviderReadiness() {
  const githubOAuthMissing = [
    !env.GITHUB_CLIENT_ID ? 'GITHUB_CLIENT_ID' : null,
    !env.GITHUB_CLIENT_SECRET ? 'GITHUB_CLIENT_SECRET' : null,
  ].filter((value): value is string => Boolean(value));
  const githubTokenMissing = [!env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : null].filter(
    (value): value is string => Boolean(value),
  );
  const resendMissing = [
    !env.RESEND_API_KEY ? 'RESEND_API_KEY' : null,
    !env.AUTH_EMAIL_FROM ? 'AUTH_EMAIL_FROM' : null,
  ].filter((value): value is string => Boolean(value));
  const uploadThingMissing = [!env.UPLOADTHING_TOKEN ? 'UPLOADTHING_TOKEN' : null].filter(
    (value): value is string => Boolean(value),
  );
  const openaiMissing = [!env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : null].filter(
    (value): value is string => Boolean(value),
  );

  return {
    github: {
      oauthConfigured: githubOAuthMissing.length === 0,
      tokenConfigured: githubTokenMissing.length === 0,
      status:
        githubOAuthMissing.length === 0 && githubTokenMissing.length === 0
          ? 'ready'
          : 'missing',
      missing: [...githubOAuthMissing, ...githubTokenMissing],
    },
    resend: providerCheck(resendMissing),
    uploadThing: providerCheck(uploadThingMissing),
    openai: providerCheck(openaiMissing, true),
  };
}

async function getDatabaseReadiness(): Promise<DatabaseCheck> {
  const startedAt = Date.now();

  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Database readiness check timed out')), 3_000);
      }),
    ]);

    return {
      reachable: true,
      status: 'ready',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      reachable: false,
      status: 'missing',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Database readiness check failed',
    };
  }
}

export async function getReadinessDiagnostics() {
  const providers = getProviderReadiness();
  const database = await getDatabaseReadiness();
  const requiredMissing = [
    ...(!database.reachable ? ['DATABASE_URL'] : []),
    ...providers.github.missing,
    ...providers.resend.missing,
    ...providers.uploadThing.missing,
  ];
  const optionalMissing = [...providers.openai.missing];

  return {
    service: 'ossdotnow-api',
    environment: env.NODE_ENV,
    ready: requiredMissing.length === 0,
    status: requiredMissing.length === 0 ? 'ready' : 'missing',
    database,
    providers,
    requiredMissing,
    optionalMissing,
  };
}
