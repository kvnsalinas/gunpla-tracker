/**
 * Kit lookup against the Gunpla Builders wiki (gunpla.fandom.com).
 *
 * Deliberately NOT gundam.fandom.com — that wiki catalogues *mobile suits*
 * (in-universe machines), so it returns anime lineart and has no notion of a
 * grade, a scale, or a box. gunpla.fandom.com catalogues the actual Bandai
 * *kits*: one page per product, each with a `Plamo_Infobox` carrying box art,
 * classification, scale, franchise, release date and JP retail price.
 *
 * Ported function-for-function from the original lookup.py so the two stay
 * diffable; the names are kept even where they aren't idiomatic TypeScript.
 */

const API = 'https://gunpla.fandom.com/api.php';

// Fandom asks for a descriptive agent and throttles generic ones.
const UA = 'GunplaRegistry/2.0 (personal collection tracker; +https://github.com/)';

const TIMEOUT_MS = 12_000;

// Images may only ever be pulled from the wiki's own CDN. This is the SSRF
// guard for /photos/from-url: the URL arrives off the wire, so without an
// allowlist it could point at localhost or a cloud metadata endpoint.
const ALLOWED_IMAGE_HOSTS = new Set(['static.wikia.nocookie.net']);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// Pages that describe a grade or product line rather than a kit you can buy.
const NON_KIT_CATEGORIES = new Set(['Grades', 'Lineup', 'Product Line', 'Product Lines']);

export class LookupError extends Error {}

interface Row {
  pageid: number;
  title: string;
  thumb: string | null;
  is_kit: boolean;
  _i?: number;
}

async function _get(params: Record<string, string | number>): Promise<any> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, format: 'json' })) {
    query.set(key, String(value));
  }

  let resp: Response;
  try {
    resp = await fetch(`${API}?${query}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LookupError(`wiki unreachable: ${err instanceof Error ? err.message : err}`);
  }

  if (!resp.ok) throw new LookupError(`wiki returned HTTP ${resp.status}`);

  try {
    return await resp.json();
  } catch (err) {
    throw new LookupError(`bad response from wiki: ${err instanceof Error ? err.message : err}`);
  }
}

const _COMMON_PROPS = {
  prop: 'pageimages|categories',
  piprop: 'thumbnail',
  pithumbsize: 220,
  cllimit: 30,
  // "RG Sazabi" is a redirect to "RG MSN-04 Sazabi"; resolving server-side
  // means the id we hand back already points at the page holding the infobox.
  redirects: 1,
};

function _rows(data: any): Row[] {
  const pages = data?.query?.pages ?? {};
  const rows: Row[] = [];
  for (const page of Object.values<any>(pages)) {
    const cats = new Set<string>(
      (page.categories ?? []).map((c: any) => String(c.title).replace('Category:', '')),
    );
    const isLineup = [...cats].some((cat) => NON_KIT_CATEGORIES.has(cat));
    rows.push({
      pageid: page.pageid,
      title: page.title,
      thumb: page.thumbnail?.source ?? null,
      // Search also surfaces the "Real Grade" / "Master Grade" overview
      // pages; flag them so the UI can sink them below real products.
      is_kit: !isLineup,
      _i: page.index ?? 999,
    });
  }
  rows.sort((a, b) => (a._i ?? 999) - (b._i ?? 999));
  return rows;
}

function _tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Kit titles start with a product-line code. Users type the grade and the
// popular name ("MG Wing Zero EW Ver Ka") and skip the model number that the
// wiki puts in between ("MG XXXG-00W0 Wing Gundam Zero EW (Ver.Ka)").
const _LINE_CODE_RE = /^(mgsd|mgex|hg|mg|rg|pg|sd|re|fm|eg)/i;

const _CACHE_TTL_SECONDS = 6 * 3600;
// The whole wiki is ~2.5k articles, so the catalogue fits in memory with room
// to spare. Indexing all of it — rather than only the queried product line —
// is what makes a bare "Sazabi" as reliable as "RG Sazabi".
const _ALLPAGES_MAX = 6000;
const _ALLPAGES_CACHE_KEY = 'https://gunpla-tracker.internal/allpages';

// Per-isolate memo. Isolates are short-lived, so the Cache API below is what
// actually keeps the six-hour warm-up from happening on every cold start.
let _allpagesMemo: { at: number; rows: [number, string][] } | null = null;

/** Every article title, paginated and cached. */
async function _allpages(): Promise<[number, string][]> {
  const now = Date.now();
  if (_allpagesMemo && now - _allpagesMemo.at < _CACHE_TTL_SECONDS * 1000) {
    return _allpagesMemo.rows;
  }

  const cache = caches.default;
  const cached = await cache.match(_ALLPAGES_CACHE_KEY);
  if (cached) {
    try {
      const rows = (await cached.json()) as [number, string][];
      _allpagesMemo = { at: now, rows };
      return rows;
    } catch {
      // fall through and re-crawl
    }
  }

  const out: [number, string][] = [];
  let cont: string | undefined;
  while (out.length < _ALLPAGES_MAX) {
    const params: Record<string, string | number> = {
      action: 'query',
      list: 'allpages',
      aplimit: 500,
      apnamespace: 0,
      apfilterredir: 'nonredirects',
    };
    if (cont) params.apcontinue = cont;

    const data = await _get(params);
    for (const page of data?.query?.allpages ?? []) {
      out.push([page.pageid, page.title]);
    }
    cont = data?.continue?.apcontinue;
    if (!cont) break;
  }

  _allpagesMemo = { at: now, rows: out };
  await cache.put(
    _ALLPAGES_CACHE_KEY,
    new Response(JSON.stringify(out), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${_CACHE_TTL_SECONDS}`,
      },
    }),
  );
  return out;
}

// Words that appear across half the catalogue. Matching one of these says
// almost nothing — "RG Sazabi Clear Color" was surfacing Strike Freedom and
// RX-78F00 purely because both are "clear" kits.
const _GENERIC = new Set([
  'gundam', 'ver', 'version', 'custom', 'type', 'mobile', 'suit', 'model',
  'kit', 'color', 'colour', 'clear', 'coating', 'plating', 'edition',
  'special', 'limited', 'the', 'of', 'and', 'frame',
]);

// Lineup/overview pages ("Real Grade", "Master Grade") rather than products.
const _LINEUP_TITLE_RE =
  /^(high|master|real|perfect|super|entry|advanced|full)\s+grade\b|^(grades?|lineup)$/i;

/** [line code, distinctive tokens, generic tokens] */
function _splitQuery(query: string): [string | null, string[], string[]] {
  let qt = _tokens(query);
  let line: string | null = null;
  if (qt.length && _LINE_CODE_RE.test(qt[0])) {
    line = qt[0];
    qt = qt.slice(1);
  }
  const key = qt.filter((t) => !_GENERIC.has(t));
  const generic = qt.filter((t) => _GENERIC.has(t));
  return [line, key, generic];
}

/** Distinctive words dominate; generic words only break ties. */
function _score(title: string, key: string[], generic: string[]): number {
  const have = new Set(_tokens(title));
  let score = 0;
  if (key.length) score += (2.0 * key.filter((t) => have.has(t)).length) / key.length;
  if (generic.length) score += (0.5 * generic.filter((t) => have.has(t)).length) / generic.length;
  return score;
}

/**
 * Drop noise, then order by relevance.
 *
 * A result must share at least one *distinctive* word with the query. Without
 * that floor the full-text index happily returns Gelgoog Menace and a Moon
 * Gundam rifle for "RG Sazabi".
 */
function _rank(query: string, rows: Row[], limit: number): Row[] {
  const [line, key, generic] = _splitQuery(query);

  const kept: { sort: [number, number, number]; row: Row }[] = [];
  for (const row of rows) {
    const title = row.title;
    if (!row.is_kit || _LINEUP_TITLE_RE.test(title)) continue;

    const titleTokens = _tokens(title);
    const have = new Set(titleTokens);
    if (key.length && !key.some((t) => have.has(t))) continue;

    const first = titleTokens[0] ?? '';
    kept.push({
      sort: [
        -_score(title, key, generic),
        line && first === line ? 0 : 1, // asked for RG? RG first
        title.length, // base kit before variants
      ],
      row,
    });
  }

  kept.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2]);
  return kept.slice(0, limit).map((entry) => entry.row);
}

/**
 * Fallback for kits missing from the search index.
 *
 * Fandom's CirrusSearch does not have every page — the MG Wing Zero EW
 * Ver.Ka entry is absent even when you search its exact title — but
 * list=allpages enumerates them regardless. So walk the title index and rank
 * by token overlap.
 */
async function _titleScan(query: string, limit: number): Promise<Row[]> {
  const [, key] = _splitQuery(query);
  if (!key.length) return [];

  const rows: Row[] = (await _allpages()).map(([pageid, title]) => ({
    pageid,
    title,
    thumb: null,
    is_kit: true,
  }));
  return _rank(query, rows, limit);
}

/** Backfill thumbnails for rows that came from a title scan. */
async function _thumbs(rows: Row[]): Promise<void> {
  const missing = rows.filter((row) => row.thumb === null);
  if (!missing.length) return;

  let data: any;
  try {
    data = await _get({
      action: 'query',
      pageids: missing
        .slice(0, 20)
        .map((row) => row.pageid)
        .join('|'),
      prop: 'pageimages',
      piprop: 'thumbnail',
      pithumbsize: 220,
    });
  } catch {
    return; // thumbnails are cosmetic; a failure here shouldn't fail the search
  }

  const byId = new Map<number, any>();
  for (const [key, page] of Object.entries<any>(data?.query?.pages ?? {})) {
    const id = Number(key);
    if (Number.isInteger(id)) byId.set(id, page);
  }
  for (const row of missing) {
    row.thumb = byId.get(row.pageid)?.thumbnail?.source ?? null;
  }
}

/**
 * Search kits, prefix matches first.
 *
 * Three strategies, because none alone is enough. Full-text search ranks
 * "RG Sazabi" below unrelated pages; prefix search finds the exact title
 * (often via a redirect) but misses anything phrased differently; and
 * neither can find a page the search index never picked up.
 */
export async function search(query: string, limit = 8): Promise<Row[]> {
  const merged = new Map<number, Row>();

  const add = (rows: Row[]) => {
    for (const row of rows) if (!merged.has(row.pageid)) merged.set(row.pageid, row);
  };

  try {
    add(
      _rows(
        await _get({
          action: 'query',
          generator: 'prefixsearch',
          gpssearch: query,
          gpslimit: limit,
          ..._COMMON_PROPS,
        }),
      ),
    );
  } catch {
    // fall through to full-text; one failed strategy is not fatal
  }

  add(
    _rows(
      await _get({
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrlimit: limit,
        ..._COMMON_PROPS,
      }),
    ),
  );

  // Always scan the local title index as well. Gating this on "did the
  // indexed results look good enough?" fails quietly: searching "PG Astray
  // Green Frame" turns up the HGGS kit, which matches every word and so looks
  // like success, while the PG entry the user actually owns is absent from
  // the wiki's search index entirely. The index is cached for six hours, so
  // this costs one slow warm-up per day.
  try {
    add(await _titleScan(query, limit));
  } catch {
    // the title index is a bonus strategy; indexed results still stand
  }

  const ranked = _rank(query, [...merged.values()], limit);
  await _thumbs(ranked);
  for (const row of ranked) delete row._i;
  return ranked;
}

/**
 * Split a template body on top-level pipes.
 *
 * Values embed templates and links ({{refyentax}}, [[Foo]]) whose own pipes
 * must not split a field, so track nesting instead of splitting on '|'.
 */
function _splitParams(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  while (i < body.length) {
    const pair = body.slice(i, i + 2);
    if (pair === '{{' || pair === '[[') {
      depth += 1;
      cur += pair;
      i += 2;
      continue;
    }
    if (pair === '}}' || pair === ']]') {
      depth -= 1;
      cur += pair;
      i += 2;
      continue;
    }
    const ch = body[i];
    if (ch === '|' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
    i += 1;
  }
  parts.push(cur);
  return parts;
}

// Editors write the template both ways, and MediaWiki treats underscore and
// space as the same title. Some pages also open with an unrelated banner
// template ({{LimitedItem}}), so match this template by name rather than
// assuming it is the first one on the page.
const _INFOBOX_RE = /\{\{\s*Plamo[_ ]Infobox/i;

function _infobox(wikitext: string): Record<string, string> {
  const match = _INFOBOX_RE.exec(wikitext);
  if (!match) return {};
  const start = match.index;

  let depth = 0;
  let i = start;
  while (i < wikitext.length) {
    const pair = wikitext.slice(i, i + 2);
    if (pair === '{{') {
      depth += 1;
      i += 2;
      continue;
    }
    if (pair === '}}') {
      depth -= 1;
      i += 2;
      if (depth === 0) break;
      continue;
    }
    i += 1;
  }

  const body = wikitext.slice(start + 2, i - 2);
  const fields: Record<string, string> = {};
  for (const part of _splitParams(body).slice(1)) {
    // [0] is the template name
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return fields;
}

/** Strip wiki markup down to plain text. */
function _clean(value: string): string {
  return value
    .replace(/\{\{[^}]*\}\}/g, '') // {{refyentax}}
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1') // [[a|b]] -> b
    .replace(/''+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _grade(classification: string): string {
  const c = classification.toLowerCase();
  if (c.includes('perfect grade')) return 'PG';
  if (c.includes('master grade')) return 'MG';
  if (c.includes('real grade')) return 'RG';
  if (c.includes('high grade')) return 'HG';
  if (/\bsd\b|super deformed/.test(c)) return 'SD';
  return 'Other';
}

/** Only a real ratio counts — 'Non (Super Deformed)' is not a scale. */
function _scale(raw: string): string {
  const m = /1\s*\/\s*(\d+)/.exec(raw);
  return m ? `1/${m[1]}` : '';
}

async function _imageUrl(filename: string): Promise<string | null> {
  let name = _clean(filename).split(';')[0].trim(); // "X.jpg;Front" -> "X.jpg"
  if (!name) return null;
  if (!name.toLowerCase().startsWith('file:')) name = `File:${name}`;

  const data = await _get({
    action: 'query',
    titles: name,
    prop: 'imageinfo',
    iiprop: 'url',
  });
  for (const page of Object.values<any>(data?.query?.pages ?? {})) {
    const url = page.imageinfo?.[0]?.url;
    if (url) return url;
  }
  return null;
}

/** Full kit record: grade, scale, series, price, box art. */
export async function detail(pageid: number): Promise<Record<string, unknown>> {
  const data = await _get({
    action: 'query',
    pageids: pageid,
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    rvsection: 0,
  });

  let page: any = data?.query?.pages?.[String(pageid)];
  if (!page) throw new LookupError('page not found');

  let wikitext: string = page.revisions?.[0]?.slots?.main?.['*'] ?? '';

  // Safety net for a redirect id reaching here directly: search resolves
  // redirects, but a bookmarked or hand-typed id may not be resolved.
  const redirect = /^#REDIRECT\s*\[\[([^\]]+)\]\]/i.exec(wikitext.trim());
  if (redirect) {
    const hop = await _get({
      action: 'query',
      titles: redirect[1],
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      rvsection: 0,
    });
    for (const target of Object.values<any>(hop?.query?.pages ?? {})) {
      const text = target.revisions?.[0]?.slots?.main?.['*'];
      if (typeof text === 'string') {
        wikitext = text;
        page = target;
        pageid = target.pageid;
      }
    }
  }

  const fields = _infobox(wikitext);
  if (!Object.keys(fields).length) throw new LookupError('that page is not a kit entry');

  const classification = _clean(fields.classification ?? '');
  const title: string = page.title ?? '';

  return {
    pageid,
    title,
    grade: _grade(classification),
    classification,
    scale: _scale(fields.scale ?? ''),
    series: _clean(fields.franchise ?? ''),
    model_of: _clean(fields['model of'] ?? ''),
    // Japanese retail, kept as text. It is not a peso price and converting
    // it would invent a number — PH retail differs and FX moves.
    price_jpy: _clean(fields.price ?? ''),
    released: _clean(fields['release date'] ?? ''),
    image: await _imageUrl(fields.image ?? ''),
    url: `https://gunpla.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
  };
}

/**
 * Download box art. Returns the bytes and the file extension.
 *
 * Redirects are followed manually so every hop can be re-checked against the
 * host allowlist — validating only the URL handed in would let an open
 * redirect walk us somewhere else.
 */
export async function fetchImage(url: string): Promise<{ data: ArrayBuffer; ext: string }> {
  const check = (candidate: string): void => {
    let parts: URL;
    try {
      parts = new URL(candidate);
    } catch {
      throw new LookupError('malformed image url');
    }
    if (parts.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(parts.hostname)) {
      throw new LookupError(`refusing to fetch from ${parts.hostname || 'unknown host'}`);
    }
  };

  let current = url;
  let resp: Response | null = null;

  for (let hop = 0; hop < 5; hop++) {
    check(current);
    try {
      resp = await fetch(current, {
        headers: { 'User-Agent': UA },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new LookupError(`could not fetch image: ${err instanceof Error ? err.message : err}`);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('Location');
      if (!location) throw new LookupError('image redirect without a target');
      current = new URL(location, current).toString();
      resp = null;
      continue;
    }
    break;
  }

  if (!resp) throw new LookupError('too many image redirects');
  if (!resp.ok) throw new LookupError(`could not fetch image: HTTP ${resp.status}`);

  const ctype = (resp.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = CONTENT_TYPE_EXT[ctype];
  if (!ext) throw new LookupError(`unsupported image type: ${ctype || 'unknown'}`);

  // Check the advertised length first so an oversized file is rejected before
  // it is buffered, then check again in case the header lied.
  const declared = Number(resp.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new LookupError('image exceeds 8 MB');
  }

  const data = await resp.arrayBuffer();
  if (data.byteLength > MAX_IMAGE_BYTES) throw new LookupError('image exceeds 8 MB');
  if (data.byteLength === 0) throw new LookupError('empty image response');

  return { data, ext };
}
