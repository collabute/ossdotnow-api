import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRouteHandler } from 'uploadthing/server';

import { auth } from './auth/server.js';
import { db } from './db/index.js';
import { account, user } from './db/schema/index.js';
import { corsOrigins, env } from './env/server.js';
import { appRouter, createContext } from './root.js';
import { ourFileRouter } from './uploadthing.js';
import { getReadinessDiagnostics } from './utils/readiness.js';

export const app = new Hono();

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      return corsOrigins.includes(origin) ? origin : null;
    },
    credentials: true,
    allowHeaders: [
      'Authorization',
      'Content-Type',
      'x-trpc-source',
      'trpc-accept',
      'x-trpc-batch-mode',
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
  }),
);

app.get('/healthz', (c) => {
  const diagnostics = getReadinessDiagnostics();

  return c.json({
    ok: true,
    timestamp: new Date().toISOString(),
    ...diagnostics,
  });
});

app.get('/api/session', async (c) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.user?.id) {
    return c.json(null, 200, {
      'Cache-Control': 'no-store',
    });
  }

  const profile = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: {
      accountType: true,
    },
  });
  const linkedAccounts = await db
    .select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, session.user.id));

  return c.json(
    {
      ...session,
      user: {
        ...session.user,
        accountType: profile?.accountType ?? null,
        connectedProviders: linkedAccounts.map((linkedAccount) => linkedAccount.providerId),
      },
    },
    200,
    {
      'Cache-Control': 'no-store',
    },
  );
});

app.on(['GET', 'POST'], '/api/auth/*', (c) => {
  return auth.handler(c.req.raw);
});

const uploadThingHandler = createRouteHandler({
  router: ourFileRouter,
  config: {
    callbackUrl: `${env.API_BASE_URL}/api/uploadthing`,
  },
});

app.all('/api/uploadthing', (c) => uploadThingHandler(c.req.raw));

app.all('/api/trpc/*', (c) => {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: c.req.raw,
    router: appRouter,
    createContext: () => createContext({ headers: c.req.raw.headers }),
    onError:
      env.NODE_ENV === 'development'
        ? ({ path, error }) => {
            console.error(`tRPC failed on ${path ?? '<no-path>'}: ${error.message}`);
          }
        : undefined,
  });
});
