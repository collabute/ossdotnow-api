import { serve } from '@hono/node-server';

import { app } from './app.js';
import { env } from './env/server.js';

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`oss.now API listening on http://localhost:${info.port}`);
  },
);
