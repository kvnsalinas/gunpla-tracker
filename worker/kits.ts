/**
 * Kit + photo routes, ported from the original Flask app.
 *
 * Every query is scoped to the caller's user_id in its WHERE clause rather
 * than by a separate ownership check, and a row owned by somebody else comes
 * back as 404 rather than 403 so collections aren't enumerable.
 */

import {
  ALLOWED_EXT,
  type Env,
  MIME_BY_EXT,
  type PhotoRow,
  STATUSES,
  type Status,
  type User,
  error,
  json,
  kitFields,
  photoRow,
} from './db';
import * as lookup from './lookup';

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Kit rows carry user_id for scoping; it's internal, so keep it off the wire. */
function publicKit(kit: Record<string, unknown>): Record<string, unknown> {
  const { user_id: _ignored, ...rest } = kit;
  return rest;
}

/** R2 key for a new photo. Namespaced by user so keys are easy to audit. */
function photoKey(userId: string, ext: string): string {
  return `u/${userId}/${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
}

/** Confirm the kit belongs to the caller, returning its id or null. */
async function ownedKitId(env: Env, kitId: number, user: User): Promise<number | null> {
  const row = await env.DB.prepare('SELECT id FROM kits WHERE id = ? AND user_id = ?')
    .bind(kitId, user.id)
    .first<{ id: number }>();
  return row ? row.id : null;
}

/* -------------------------------------------------------------------- kits */

export async function listKits(request: Request, env: Env, user: User): Promise<Response> {
  const status = new URL(request.url).searchParams.get('status');

  const scoped = status && STATUSES.includes(status as Status);
  const stmt = scoped
    ? env.DB.prepare(
        'SELECT * FROM kits WHERE user_id = ? AND status = ? ORDER BY created_at DESC, id DESC',
      ).bind(user.id, status)
    : env.DB.prepare(
        'SELECT * FROM kits WHERE user_id = ? ORDER BY created_at DESC, id DESC',
      ).bind(user.id);

  const { results } = await stmt.all<Record<string, unknown>>();
  if (results.length === 0) return json([]);

  // Thumbnails and counts for the whole page in one query, rather than two
  // per kit. Reached by joining through kits rather than an IN (...) over the
  // ids: D1 caps a statement at 100 bound parameters, so a list built that way
  // would start failing outright once a collection passed 100 kits.
  const photoStmt = scoped
    ? env.DB.prepare(
        `SELECT p.kit_id, p.filename FROM photos p JOIN kits k ON k.id = p.kit_id
          WHERE k.user_id = ? AND k.status = ?
          ORDER BY p.kit_id ASC, p.is_box_art DESC, p.sort_order ASC, p.id ASC`,
      ).bind(user.id, status)
    : env.DB.prepare(
        `SELECT p.kit_id, p.filename FROM photos p JOIN kits k ON k.id = p.kit_id
          WHERE k.user_id = ?
          ORDER BY p.kit_id ASC, p.is_box_art DESC, p.sort_order ASC, p.id ASC`,
      ).bind(user.id);

  const { results: photos } = await photoStmt.all<{ kit_id: number; filename: string }>();

  const thumbnails = new Map<number, string>();
  const counts = new Map<number, number>();
  for (const photo of photos) {
    if (!thumbnails.has(photo.kit_id)) thumbnails.set(photo.kit_id, `/uploads/${photo.filename}`);
    counts.set(photo.kit_id, (counts.get(photo.kit_id) ?? 0) + 1);
  }

  return json(
    results.map((kit) => ({
      ...publicKit(kit),
      thumbnail: thumbnails.get(Number(kit.id)) ?? null,
      photo_count: counts.get(Number(kit.id)) ?? 0,
    })),
  );
}

export async function getKit(kitId: number, env: Env, user: User): Promise<Response> {
  const kit = await env.DB.prepare('SELECT * FROM kits WHERE id = ? AND user_id = ?')
    .bind(kitId, user.id)
    .first<Record<string, unknown>>();
  if (!kit) return error('not found', 404);

  const { results } = await env.DB.prepare(
    'SELECT * FROM photos WHERE kit_id = ? ORDER BY is_box_art DESC, sort_order ASC, id ASC',
  )
    .bind(kitId)
    .all<PhotoRow>();

  return json({ ...publicKit(kit), photos: results.map(photoRow) });
}

export async function createKit(request: Request, env: Env, user: User): Promise<Response> {
  const fields = kitFields(await readJson(request));
  if (!fields.name) return error('name is required', 400);

  const row = await env.DB.prepare(
    `INSERT INTO kits (user_id, name, grade, scale, series, status, price_msrp,
                       price_paid, store, date_acquired, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      user.id,
      fields.name,
      fields.grade,
      fields.scale,
      fields.series,
      fields.status,
      fields.price_msrp,
      fields.price_paid,
      fields.store,
      fields.date_acquired,
      fields.notes,
    )
    .first<{ id: number }>();

  return json({ id: row!.id, ...fields }, 201);
}

export async function updateKit(
  request: Request,
  kitId: number,
  env: Env,
  user: User,
): Promise<Response> {
  const existing = await env.DB.prepare('SELECT * FROM kits WHERE id = ? AND user_id = ?')
    .bind(kitId, user.id)
    .first<Record<string, unknown>>();
  if (!existing) return error('not found', 404);

  // PATCH semantics: unspecified fields keep their current value.
  const fields = kitFields({ ...existing, ...(await readJson(request)) });
  if (!fields.name) return error('name is required', 400);

  await env.DB.prepare(
    `UPDATE kits SET name = ?, grade = ?, scale = ?, series = ?, status = ?,
                     price_msrp = ?, price_paid = ?, store = ?, date_acquired = ?, notes = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(
      fields.name,
      fields.grade,
      fields.scale,
      fields.series,
      fields.status,
      fields.price_msrp,
      fields.price_paid,
      fields.store,
      fields.date_acquired,
      fields.notes,
      kitId,
      user.id,
    )
    .run();

  return json({ id: kitId, ...fields });
}

export async function deleteKit(kitId: number, env: Env, user: User): Promise<Response> {
  if ((await ownedKitId(env, kitId, user)) === null) return error('not found', 404);

  const { results: photos } = await env.DB.prepare(
    'SELECT filename FROM photos WHERE kit_id = ?',
  )
    .bind(kitId)
    .all<{ filename: string }>();

  // D1 doesn't enforce ON DELETE CASCADE across statements, so children go first.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM photos WHERE kit_id = ?').bind(kitId),
    env.DB.prepare('DELETE FROM kits WHERE id = ? AND user_id = ?').bind(kitId, user.id),
  ]);

  // Blobs only after the rows are gone: an orphaned object is harmless, a
  // row pointing at a missing object is a broken image.
  if (photos.length > 0) {
    await env.PHOTOS.delete(photos.map((photo) => photo.filename));
  }

  return json({ ok: true });
}

/* ------------------------------------------------------------------ photos */

async function insertPhoto(
  env: Env,
  kitId: number,
  key: string,
  caption: string,
  isBoxArt: boolean,
): Promise<Response> {
  const row = await env.DB.prepare(
    'INSERT INTO photos (kit_id, filename, caption, is_box_art) VALUES (?, ?, ?, ?) RETURNING *',
  )
    .bind(kitId, key, caption, isBoxArt ? 1 : 0)
    .first<PhotoRow>();

  return json(photoRow(row!), 201);
}

export async function uploadPhoto(
  request: Request,
  kitId: number,
  env: Env,
  user: User,
): Promise<Response> {
  if ((await ownedKitId(env, kitId, user)) === null) return error('kit not found', 404);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error('expected a multipart form upload', 400);
  }

  // A FormData entry is either a File or a plain string; anything but a named
  // File means the client didn't actually attach one.
  const file = form.get('photo');
  if (file === null || typeof file === 'string' || !file.name) {
    return error('photo file is required', 400);
  }

  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (!ALLOWED_EXT.has(ext)) return error(`unsupported file type .${ext}`, 400);

  const key = photoKey(user.id, ext);
  await env.PHOTOS.put(key, file.stream(), {
    httpMetadata: { contentType: MIME_BY_EXT[ext] },
  });

  const isBoxArt = ['1', 'true', 'on'].includes(String(form.get('is_box_art') ?? ''));
  const caption = String(form.get('caption') ?? '').trim();
  return insertPhoto(env, kitId, key, caption, isBoxArt);
}

/** Import wiki art server-side. The URL host is allowlisted in lookup.ts. */
export async function importPhoto(
  request: Request,
  kitId: number,
  env: Env,
  user: User,
): Promise<Response> {
  const body = await readJson(request);
  const url = (typeof body.url === 'string' ? body.url : '').trim();
  if (!url) return error('url is required', 400);

  if ((await ownedKitId(env, kitId, user)) === null) return error('kit not found', 404);

  let image: { data: ArrayBuffer; ext: string };
  try {
    image = await lookup.fetchImage(url);
  } catch (err) {
    return error(err instanceof Error ? err.message : 'image fetch failed', 502);
  }

  const key = photoKey(user.id, image.ext);
  await env.PHOTOS.put(key, image.data, {
    httpMetadata: { contentType: MIME_BY_EXT[image.ext] },
  });

  const caption = (typeof body.caption === 'string' ? body.caption : '').trim();
  return insertPhoto(env, kitId, key, caption, Boolean(body.is_box_art));
}

export async function deletePhoto(photoId: number, env: Env, user: User): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.filename FROM photos p
       JOIN kits k ON k.id = p.kit_id
      WHERE p.id = ? AND k.user_id = ?`,
  )
    .bind(photoId, user.id)
    .first<{ id: number; filename: string }>();
  if (!row) return error('not found', 404);

  await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photoId).run();
  await env.PHOTOS.delete(row.filename);
  return json({ ok: true });
}

/**
 * Serve an uploaded image out of R2. Collections are private, so the key
 * alone isn't enough — it has to belong to one of the caller's kits.
 */
export async function servePhoto(key: string, env: Env, user: User): Promise<Response> {
  const owned = await env.DB.prepare(
    `SELECT 1 FROM photos p JOIN kits k ON k.id = p.kit_id
      WHERE p.filename = ? AND k.user_id = ?`,
  )
    .bind(key, user.id)
    .first();
  if (!owned) return error('not found', 404);

  const object = await env.PHOTOS.get(key);
  if (!object) return error('not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Keys are immutable UUIDs, so this can cache hard — but privately, since
  // the response is user-scoped.
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

/* ------------------------------------------------------------------- stats */

export async function stats(env: Env, user: User): Promise<Response> {
  const [byStatusRes, byGradeRes, spentRes, wishlistRes] = await env.DB.batch<
    Record<string, unknown>
  >([
    env.DB.prepare('SELECT status, COUNT(*) c FROM kits WHERE user_id = ? GROUP BY status').bind(
      user.id,
    ),
    env.DB.prepare('SELECT grade, COUNT(*) c FROM kits WHERE user_id = ? GROUP BY grade').bind(
      user.id,
    ),
    env.DB.prepare(
      "SELECT COALESCE(SUM(price_paid), 0) s FROM kits WHERE user_id = ? AND status != 'wishlist'",
    ).bind(user.id),
    env.DB.prepare(
      "SELECT COALESCE(SUM(price_msrp), 0) s FROM kits WHERE user_id = ? AND status = 'wishlist'",
    ).bind(user.id),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of byStatusRes.results) byStatus[String(row.status)] = Number(row.c);

  const byGrade: Record<string, number> = {};
  for (const row of byGradeRes.results) byGrade[String(row.grade)] = Number(row.c);

  const round2 = (value: number) => Math.round(value * 100) / 100;

  return json({
    by_status: byStatus,
    by_grade: byGrade,
    total_kits: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    backlog: byStatus.owned ?? 0,
    total_spent: round2(Number(spentRes.results[0]?.s ?? 0)),
    wishlist_value: round2(Number(wishlistRes.results[0]?.s ?? 0)),
  });
}
