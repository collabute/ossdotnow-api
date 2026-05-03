import { earlySubmissionRouter } from './routers/early-submissions.js';
import { createTRPCContext, createTRPCRouter } from './trpc.js';
import { earlyAccessRouter } from './routers/early-access.js';
import { projectsRouter } from './routers/projects.js';
import { systemRouter } from './routers/system.js';
import { githubRouter } from './routers/github.js';
import { usersRouter } from './routers/users.js';
import { adminRouter } from './routers/admin.js';
import { userRouter } from './routers/user.js';

export const appRouter = createTRPCRouter({
  earlyAccess: earlyAccessRouter,
  user: userRouter,
  users: usersRouter,
  projects: projectsRouter,
  earlySubmission: earlySubmissionRouter,
  github: githubRouter,
  admin: adminRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;

export const createContext = createTRPCContext;

export type { DebugPermissionsResult } from './routers/projects.js';
