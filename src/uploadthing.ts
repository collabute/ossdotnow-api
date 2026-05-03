import { createUploadthing, type FileRouter, UploadThingError } from 'uploadthing/server';

import { auth } from './auth/server.js';

const f = createUploadthing();

export const ourFileRouter = {
  'project-logos': f({
    image: {
      maxFileSize: '4MB',
      maxFileCount: 1,
    },
  })
    .middleware(async ({ req }) => {
      const session = await auth.api.getSession({
        headers: req.headers,
      });

      if (!session?.user?.id) {
        throw new UploadThingError({
          code: 'FORBIDDEN',
          message: 'You must be signed in to upload project logos.',
        });
      }

      return {
        userId: session.user.id,
      };
    })
    .onUploadComplete(async ({ file, metadata }) => {
      return {
        url: file.ufsUrl,
        uploadedBy: metadata.userId,
      };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
