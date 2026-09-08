/**
 * Username + password auth. No email, no confirmation step.
 *
 * Passwords are hashed with PBKDF2-SHA256 via WebCrypto (bcrypt/argon2 would
 * need a WASM build, which isn't worth it for a two-person app). Sessions are
 * opaque random tokens stored in D1 so that logging out actually revokes them.
 */

import { type Env, type User, HttpError, error, json } from './db';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const SESSION_COOKIE = 'session';
const SESSION_DAYS = 30;
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const MIN_PASSWORD = 8;

/* ---------------------------------------------------------------- hashing */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Encoded as pbkdf2$<iterations>$<salt_b64>$<hash_b64> so the cost can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  try {
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    const actual = await pbkdf2(password, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- sessions */

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sessionCookie(token: string, maxAge: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt)
    .run();
  return token;
}

/** Resolve the caller from their session cookie, or null when not signed in. */
export async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
  )
    .bind(token)
    .first<{ id: string; username: string; display_name: string; expires_at: string }>();

  if (!row) return null;

  // Expired sessions are swept lazily, on the request that trips over them.
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }

  return { id: row.id, username: row.username, display_name: row.display_name };
}

/** Same as currentUser, but aborts the request with a 401 instead of returning null. */
export async function requireUser(request: Request, env: Env): Promise<User> {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError('authentication required', 401);
  return user;
}

/* ----------------------------------------------------------------- routes */

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function signup(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);

  // When SIGNUP_CODE is configured, registration is invite-only. Without it
  // anyone who finds the URL could create an account.
  if (env.SIGNUP_CODE) {
    const code = typeof body.code === 'string' ? body.code : '';
    if (code !== env.SIGNUP_CODE) return error('invalid signup code', 403);
  }

  const rawUsername = typeof body.username === 'string' ? body.username : '';
  const username = rawUsername.trim().toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_RE.test(username)) {
    return error('username must be 3-32 characters: letters, numbers, _ or -', 400);
  }
  if (password.length < MIN_PASSWORD) {
    return error(`password must be at least ${MIN_PASSWORD} characters`, 400);
  }

  const taken = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (taken) return error('that username is taken', 409);

  const id = crypto.randomUUID();
  const displayName = rawUsername.trim();
  await env.DB.prepare(
    'INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)',
  )
    .bind(id, username, displayName, await hashPassword(password))
    .run();

  const token = await createSession(env, id);
  return json({ id, username, display_name: displayName }, 201, {
    'Set-Cookie': sessionCookie(token, SESSION_MAX_AGE),
  });
}

export async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const username = (typeof body.username === 'string' ? body.username : '').trim().toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  const row = await env.DB.prepare(
    'SELECT id, username, display_name, password_hash FROM users WHERE username = ?',
  )
    .bind(username)
    .first<{ id: string; username: string; display_name: string; password_hash: string }>();

  // Hash against a dummy value for unknown users so the response time doesn't
  // reveal whether the account exists.
  const encoded = row?.password_hash ?? (await hashPassword('placeholder'));
  const ok = await verifyPassword(password, encoded);

  if (!row || !ok) return error('incorrect username or password', 401);

  const token = await createSession(env, row.id);
  return json({ id: row.id, username: row.username, display_name: row.display_name }, 200, {
    'Set-Cookie': sessionCookie(token, SESSION_MAX_AGE),
  });
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

export async function me(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) return error('authentication required', 401);
  return json(user);
}
