/** Shared types, constants and small response helpers. */

export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  /** Optional. When set, signup requires a matching `code` in the body. */
  SIGNUP_CODE?: string;
}

export const STATUSES = ['wishlist', 'owned', 'building', 'built'] as const;
export const GRADES = ['HG', 'RG', 'MG', 'PG', 'SD', 'Other'] as const;

export type Status = (typeof STATUSES)[number];
export type Grade = (typeof GRADES)[number];

export const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export interface User {
  id: string;
  username: string;
  display_name: string;
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Raised by a route to abort with a specific status; caught by the router. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Pull + normalize kit fields from an incoming JSON body.
 *
 * Deliberately lenient, matching the original Flask behaviour: an unknown
 * status falls back to wishlist, an unknown grade to Other, and an
 * unparseable price to null rather than erroring the whole request.
 */
export function kitFields(data: Record<string, unknown>) {
  const rawStatus = data.status;
  const status = STATUSES.includes(rawStatus as Status) ? (rawStatus as Status) : 'wishlist';

  const rawGrade = data.grade;
  const grade = GRADES.includes(rawGrade as Grade) ? (rawGrade as Grade) : 'Other';

  const str = (key: string): string => {
    const val = data[key];
    return val === null || val === undefined ? '' : String(val).trim();
  };

  const num = (key: string): number | null => {
    const val = data[key];
    if (val === null || val === undefined || val === '') return null;
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    name: str('name'),
    grade,
    scale: str('scale'),
    series: str('series'),
    status,
    price_msrp: num('price_msrp'),
    price_paid: num('price_paid'),
    store: str('store'),
    date_acquired: str('date_acquired'),
    notes: str('notes'),
  };
}

export interface PhotoRow {
  id: number;
  filename: string;
  caption: string;
  is_box_art: number;
}

export function photoRow(row: PhotoRow) {
  return {
    id: row.id,
    url: `/uploads/${row.filename}`,
    caption: row.caption,
    is_box_art: Boolean(row.is_box_art),
  };
}
