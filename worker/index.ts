/**
 * Gunpla Tracker — Cloudflare Worker entry point.
 *
 * Handles /api/* and /uploads/*, and hands everything else to the static site
 * in web/ via the ASSETS binding. Routes keep the paths, methods and JSON
 * shapes of the original Flask app, so the frontend contract is unchanged.
 */

import * as auth from './auth';
import { type Env, HttpError, error, json } from './db';
import * as kits from './kits';
import * as lookup from './lookup';

/** Match a path against a template like /api/kits/:id, returning the captures. */
function match(path: string, template: string): string[] | null {
  const pathParts = path.split('/');
  const templateParts = template.split('/');
  if (pathParts.length !== templateParts.length) return null;

  const captures: string[] = [];
  for (let i = 0; i < templateParts.length; i++) {
    if (templateParts[i].startsWith(':')) {
      if (!pathParts[i]) return null;
      captures.push(decodeURIComponent(pathParts[i]));
    } else if (templateParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return captures;
}

function intOrNull(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

async function route(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  /* ------------------------------------------------------------ auth */

  if (path === '/api/auth/signup' && method === 'POST') return auth.signup(request, env);
  if (path === '/api/auth/login' && method === 'POST') return auth.login(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return auth.logout(request, env);
  if (path === '/api/auth/me' && method === 'GET') return auth.me(request, env);

  /* ------------------------------------------ everything below is private */

  if (path === '/api/kits' && method === 'GET') {
    return kits.listKits(request, env, await auth.requireUser(request, env));
  }
  if (path === '/api/kits' && method === 'POST') {
    return kits.createKit(request, env, await auth.requireUser(request, env));
  }

  let params = match(path, '/api/kits/:id');
  if (params) {
    const kitId = intOrNull(params[0]);
    if (kitId === null) return error('not found', 404);
    const user = await auth.requireUser(request, env);
    if (method === 'GET') return kits.getKit(kitId, env, user);
    if (method === 'PATCH') return kits.updateKit(request, kitId, env, user);
    if (method === 'DELETE') return kits.deleteKit(kitId, env, user);
    return error('method not allowed', 405);
  }

  params = match(path, '/api/kits/:id/photos');
  if (params && method === 'POST') {
    const kitId = intOrNull(params[0]);
    if (kitId === null) return error('kit not found', 404);
    return kits.uploadPhoto(request, kitId, env, await auth.requireUser(request, env));
  }

  params = match(path, '/api/kits/:id/photos/from-url');
  if (params && method === 'POST') {
    const kitId = intOrNull(params[0]);
    if (kitId === null) return error('kit not found', 404);
    return kits.importPhoto(request, kitId, env, await auth.requireUser(request, env));
  }

  params = match(path, '/api/photos/:id');
  if (params && method === 'DELETE') {
    const photoId = intOrNull(params[0]);
    if (photoId === null) return error('not found', 404);
    return kits.deletePhoto(photoId, env, await auth.requireUser(request, env));
  }

  if (path === '/api/stats' && method === 'GET') {
    return kits.stats(env, await auth.requireUser(request, env));
  }

  /* ---------------------------------------------------------- wiki lookup */

  if (path === '/api/lookup' && method === 'GET') {
    await auth.requireUser(request, env);
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q.length < 2) return error('query too short', 400);
    try {
      return json(await lookup.search(q));
    } catch (err) {
      // 502: we're fine, the upstream wiki isn't. Lets the UI say so plainly
      // instead of blaming the user's input.
      return error(err instanceof Error ? err.message : 'lookup failed', 502);
    }
  }

  params = match(path, '/api/lookup/:pageid');
  if (params && method === 'GET') {
    await auth.requireUser(request, env);
    const pageid = intOrNull(params[0]);
    if (pageid === null) return error('not found', 404);
    try {
      return json(await lookup.detail(pageid));
    } catch (err) {
      return error(err instanceof Error ? err.message : 'lookup failed', 502);
    }
  }

  /* --------------------------------------------------------------- photos */

  if (path.startsWith('/uploads/') && method === 'GET') {
    const key = decodeURIComponent(path.slice('/uploads/'.length));
    if (!key) return error('not found', 404);
    return kits.servePhoto(key, env, await auth.requireUser(request, env));
  }

  // Anything else under /api is a genuine 404 rather than a static asset.
  if (path.startsWith('/api/')) return error('not found', 404);

  return null; // fall through to the static site
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response | null;
    try {
      response = await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return error(err.message, err.status);
      console.error('unhandled error', err);
      return error('internal error', 500);
    }
    return response ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
