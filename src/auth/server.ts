import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin } from 'better-auth/plugins';
import { betterAuth } from 'better-auth';

import { db } from '../db/index.js';
import { corsOrigins, env } from '../env/server.js';
import { sendAuthEmail } from './email.js';

const hasGitHubOAuth = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

if (env.NODE_ENV !== 'production') {
  if (!hasGitHubOAuth) {
    console.warn(
      'GitHub OAuth is disabled. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable it.',
    );
  }

}

export const auth = betterAuth({
  baseURL: env.API_BASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'pg',
  }),
  plugins: [admin()],
  trustedOrigins: corsOrigins,
  account: {
    storeStateStrategy: 'cookie',
    accountLinking: {
      enabled: true,
      trustedProviders: ['github', 'email-password'],
      allowDifferentEmails: false,
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendAuthEmail({
        to: user.email,
        type: 'password-reset',
        subject: 'Reset your oss.now password',
        body: 'Use this secure link to choose a new password for your oss.now account.',
        actionText: 'Reset password',
        actionUrl: url,
      });
    },
    onExistingUserSignUp: async ({ user }) => {
      await sendAuthEmail({
        to: user.email,
        type: 'existing-signup',
        subject: 'Someone tried to sign up with your email',
        body: 'Someone tried to create a new oss.now account with this email. If this was you, sign in instead. If it was not you, no action is needed.',
      });
    },
    customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
      ...coreFields,
      role: 'user',
      banned: false,
      banReason: null,
      banExpires: null,
      ...additionalFields,
      id,
    }),
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendAuthEmail({
        to: user.email,
        type: 'verification',
        subject: 'Verify your oss.now email',
        body: 'Confirm this email address to finish setting up your oss.now account.',
        actionText: 'Verify email',
        actionUrl: url,
      });
    },
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
  },
  advanced: {
    crossSubDomainCookies: {
      enabled: env.NODE_ENV === 'production',
      domain: env.AUTH_COOKIE_DOMAIN,
    },
  },
  socialProviders: {
    ...(hasGitHubOAuth
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            scope: ['user', 'repo'],
          },
        }
      : {}),
  },
});

export type Session = typeof auth.$Infer.Session;
