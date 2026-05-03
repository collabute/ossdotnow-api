import { env } from '../env/server.js';

type ReadinessStatus = 'ready' | 'degraded' | 'missing';

type ProviderCheck = {
  configured: boolean;
  status: ReadinessStatus;
  missing: string[];
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
  const googleOAuthMissing = [
    !env.GOOGLE_CLIENT_ID ? 'GOOGLE_CLIENT_ID' : null,
    !env.GOOGLE_CLIENT_SECRET ? 'GOOGLE_CLIENT_SECRET' : null,
  ].filter((value): value is string => Boolean(value));
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
    google: {
      oauthConfigured: googleOAuthMissing.length === 0,
      ...providerCheck(googleOAuthMissing),
    },
    resend: providerCheck(resendMissing),
    uploadThing: providerCheck(uploadThingMissing),
    openai: providerCheck(openaiMissing, true),
  };
}

export function getReadinessDiagnostics() {
  const providers = getProviderReadiness();
  const requiredMissing = [
    ...providers.github.missing,
    ...providers.google.missing,
    ...providers.resend.missing,
    ...providers.uploadThing.missing,
  ];
  const optionalMissing = [...providers.openai.missing];

  return {
    service: 'ossdotnow-api',
    environment: env.NODE_ENV,
    ready: requiredMissing.length === 0,
    status: requiredMissing.length === 0 ? 'ready' : 'missing',
    providers,
    requiredMissing,
    optionalMissing,
  };
}
