import { createTRPCRouter, publicProcedure } from '../trpc.js';
import { getProviderReadiness } from '../utils/readiness.js';

export const systemRouter = createTRPCRouter({
  providerStatus: publicProcedure.query(() => getProviderReadiness()),
});
