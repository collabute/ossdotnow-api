import { handle } from '@hono/node-server/vercel';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import { app } from '../src/app.js';

export const config = {
  runtime: 'nodejs',
};

type VercelRequest = IncomingMessage & {
  body?: unknown;
  rawBody?: Buffer | string | Uint8Array;
};

type RequestBody = {
  body: BodyInit | undefined;
  rebuilt: boolean;
};

const honoHandler = handle(app);
const bodylessMethods = new Set(['GET', 'HEAD']);

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const requestUrl = (req: VercelRequest) => {
  const url = req.url ?? '/';

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers.host);
  const protocol = firstHeader(req.headers['x-forwarded-proto']) ?? 'https';

  if (!host) {
    throw new Error('Missing host header');
  }

  return `${protocol}://${host}${url}`;
};

const requestHeaders = (headers: IncomingHttpHeaders, dropContentLength: boolean) => {
  const nextHeaders = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const entry of value) {
        nextHeaders.append(key, entry);
      }
      continue;
    }

    nextHeaders.set(key, String(value));
  }

  if (dropContentLength) {
    nextHeaders.delete('content-length');
  }

  return nextHeaders;
};

const serializeParsedBody = (body: unknown, contentType: string): BodyInit | undefined => {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string' || body instanceof Uint8Array) {
    return body;
  }

  if (contentType.includes('application/x-www-form-urlencoded') && typeof body === 'object') {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          params.append(key, String(entry));
        }
        continue;
      }

      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }

    return params;
  }

  return JSON.stringify(body);
};

const readStreamBody = async (req: VercelRequest) => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
};

const requestBody = async (req: VercelRequest): Promise<RequestBody> => {
  if (bodylessMethods.has(req.method ?? 'GET')) {
    return { body: undefined, rebuilt: false };
  }

  if (req.rawBody !== undefined) {
    return { body: req.rawBody, rebuilt: false };
  }

  if (req.body !== undefined) {
    const contentType = firstHeader(req.headers['content-type'])?.toLowerCase() ?? '';

    return {
      body: serializeParsedBody(req.body, contentType),
      rebuilt: true,
    };
  }

  return { body: await readStreamBody(req), rebuilt: false };
};

const fetchRequest = async (req: VercelRequest) => {
  const { body, rebuilt } = await requestBody(req);
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: requestHeaders(req.headers, rebuilt),
  };

  if (body !== undefined) {
    init.body = body;
    init.duplex = 'half';
  }

  return new Request(requestUrl(req), init);
};

const writeResponse = async (res: ServerResponse, response: Response) => {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  const setCookies = response.headers.getSetCookie?.();

  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie' && setCookies?.length) continue;
    res.setHeader(key, value);
  }

  if (setCookies?.length) {
    res.setHeader('set-cookie', setCookies);
  }

  res.end(Buffer.from(await response.arrayBuffer()));
};

const isAuthPost = (req: VercelRequest) => {
  if (req.method !== 'POST') return false;

  try {
    return new URL(requestUrl(req)).pathname.startsWith('/api/auth/');
  } catch {
    return false;
  }
};

export default async function handler(req: VercelRequest, res: ServerResponse) {
  if (!isAuthPost(req)) {
    return honoHandler(req, res);
  }

  try {
    await writeResponse(res, await app.fetch(await fetchRequest(req)));
  } catch (error) {
    console.error('Failed to handle auth request', error);

    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
    }

    res.end(JSON.stringify({ message: 'Internal server error' }));
  }
}
