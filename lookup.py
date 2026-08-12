"""Kit lookup against the Gunpla Builders wiki (gunpla.fandom.com).

Deliberately NOT gundam.fandom.com — that wiki catalogues *mobile suits*
(in-universe machines), so it returns anime lineart and has no notion of a
grade, a scale, or a box. gunpla.fandom.com catalogues the actual Bandai
*kits*: one page per product, each with a `Plamo_Infobox` carrying box art,
classification, scale, franchise, release date and JP retail price.

Stdlib only (urllib), so the app keeps its zero-dependency install.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://gunpla.fandom.com/api.php"

# Fandom asks for a descriptive agent and throttles the default urllib one.
UA = "GunplaRegistry/1.0 (personal collection tracker; +https://github.com/)"

TIMEOUT = 12

# Images may only ever be pulled from the wiki's own CDN. This is the SSRF
# guard for /photos/from-url: the URL arrives off the wire, so without an
# allowlist it could point at localhost or a cloud metadata endpoint.
ALLOWED_IMAGE_HOSTS = {"static.wikia.nocookie.net"}

MAX_IMAGE_BYTES = 8 * 1024 * 1024

CONTENT_TYPE_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}

# Pages that describe a grade or product line rather than a kit you can buy.
NON_KIT_CATEGORIES = {"Grades", "Lineup", "Product Line", "Product Lines"}


class LookupError(RuntimeError):
    pass


def _get(params: dict) -> dict:
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.URLError as exc:
        raise LookupError(f"wiki unreachable: {exc.reason}") from exc
    except (ValueError, TimeoutError) as exc:
        raise LookupError(f"bad response from wiki: {exc}") from exc


_COMMON_PROPS = {
    "prop": "pageimages|categories",
    "piprop": "thumbnail",
    "pithumbsize": 220,
    "cllimit": 30,
    # "RG Sazabi" is a redirect to "RG MSN-04 Sazabi"; resolving server-side
    # means the id we hand back already points at the page holding the infobox.
    "redirects": 1,
}


def _rows(data: dict) -> list[dict]:
    pages = (data.get("query") or {}).get("pages") or {}
    rows = []
    for page in pages.values():
        cats = {c["title"].replace("Category:", "") for c in page.get("categories", [])}
        rows.append({
            "pageid": page["pageid"],
            "title": page["title"],
            "thumb": (page.get("thumbnail") or {}).get("source"),
            # Search also surfaces the "Real Grade" / "Master Grade" overview
            # pages; flag them so the UI can sink them below real products.
            "is_kit": not (cats & NON_KIT_CATEGORIES),
            "_i": page.get("index", 999),
        })
    rows.sort(key=lambda r: r["_i"])
    return rows


def _tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


# Kit titles start with a product-line code. Users type the grade and the
# popular name ("MG Wing Zero EW Ver Ka") and skip the model number that the
# wiki puts in between ("MG XXXG-00W0 Wing Gundam Zero EW (Ver.Ka)").
_LINE_CODE_RE = re.compile(r"^(mgsd|mgex|hg|mg|rg|pg|sd|re|fm|eg)", re.I)

_ALLPAGES_CACHE: dict[str, tuple[float, list[tuple[int, str]]]] = {}
_CACHE_TTL = 6 * 3600
# The whole wiki is ~2.5k articles, so the catalogue fits in memory with room
# to spare. Indexing all of it — rather than only the queried product line —
# is what makes a bare "Sazabi" as reliable as "RG Sazabi".
_ALLPAGES_MAX = 6000


def _allpages(prefix: str = "") -> list[tuple[int, str]]:
    """Every article title, paginated and cached. Empty prefix = whole wiki."""
    now = time.time()
    cached = _ALLPAGES_CACHE.get(prefix)
    if cached and now - cached[0] < _CACHE_TTL:
        return cached[1]

    out: list[tuple[int, str]] = []
    cont = None
    while len(out) < _ALLPAGES_MAX:
        params = {"action": "query", "list": "allpages", "aplimit": 500,
                  "apnamespace": 0, "apfilterredir": "nonredirects"}
        if prefix:
            params["apprefix"] = prefix
        if cont:
            params["apcontinue"] = cont
        data = _get(params)
        out.extend((p["pageid"], p["title"])
                   for p in (data.get("query") or {}).get("allpages", []))
        cont = (data.get("continue") or {}).get("apcontinue")
        if not cont:
            break

    _ALLPAGES_CACHE[prefix] = (now, out)
    return out


# Words that appear across half the catalogue. Matching one of these says
# almost nothing — "RG Sazabi Clear Color" was surfacing Strike Freedom and
# RX-78F00 purely because both are "clear" kits.
_GENERIC = {
    "gundam", "ver", "version", "custom", "type", "mobile", "suit", "model",
    "kit", "color", "colour", "clear", "coating", "plating", "edition",
    "special", "limited", "the", "of", "and", "frame",
}

# Lineup/overview pages ("Real Grade", "Master Grade") rather than products.
_LINEUP_TITLE_RE = re.compile(
    r"^(high|master|real|perfect|super|entry|advanced|full)\s+grade\b|^(grades?|lineup)$",
    re.I,
)


def _split_query(query: str) -> tuple[str | None, list[str], list[str]]:
    """(line code, distinctive tokens, generic tokens)."""
    qt = _tokens(query)
    line = None
    if qt and _LINE_CODE_RE.match(qt[0]):
        line, qt = qt[0], qt[1:]
    key = [t for t in qt if t not in _GENERIC]
    generic = [t for t in qt if t in _GENERIC]
    return line, key, generic


def _score(title: str, key: list[str], generic: list[str]) -> float:
    """Distinctive words dominate; generic words only break ties."""
    have = set(_tokens(title))
    score = 0.0
    if key:
        score += 2.0 * sum(1 for t in key if t in have) / len(key)
    if generic:
        score += 0.5 * sum(1 for t in generic if t in have) / len(generic)
    return score


def _rank(query: str, rows: list[dict], limit: int) -> list[dict]:
    """Drop noise, then order by relevance.

    A result must share at least one *distinctive* word with the query. Without
    that floor the full-text index happily returns Gelgoog Menace and a Moon
    Gundam rifle for "RG Sazabi".
    """
    line, key, generic = _split_query(query)

    kept = []
    for row in rows:
        title = row["title"]
        if not row["is_kit"] or _LINEUP_TITLE_RE.match(title):
            continue
        have = set(_tokens(title))
        if key and not any(t in have for t in key):
            continue
        first = (_tokens(title) or [""])[0]
        kept.append((
            -_score(title, key, generic),
            0 if (line and first == line) else 1,   # asked for RG? RG first
            len(title),                              # base kit before variants
            row,
        ))

    kept.sort(key=lambda r: r[:3])
    return [r[3] for r in kept[:limit]]


def _title_scan(query: str, limit: int) -> list[dict]:
    """Fallback for kits missing from the search index.

    Fandom's CirrusSearch does not have every page — the MG Wing Zero EW
    Ver.Ka entry is absent even when you search its exact title — but
    list=allpages enumerates them regardless. So walk the titles under the
    query's product-line code and rank them by token overlap.
    """
    _line, key, _generic = _split_query(query)
    if not key:
        return []

    rows = [{"pageid": pid, "title": title, "thumb": None, "is_kit": True}
            for pid, title in _allpages()]
    return _rank(query, rows, limit)


def _thumbs(rows: list[dict]) -> None:
    """Backfill thumbnails for rows that came from a title scan."""
    missing = [r for r in rows if r["thumb"] is None]
    if not missing:
        return
    try:
        data = _get({
            "action": "query",
            "pageids": "|".join(str(r["pageid"]) for r in missing[:20]),
            "prop": "pageimages",
            "piprop": "thumbnail",
            "pithumbsize": 220,
        })
    except LookupError:
        return
    pages = (data.get("query") or {}).get("pages") or {}
    by_id = {int(k): v for k, v in pages.items() if k.lstrip("-").isdigit()}
    for row in missing:
        page = by_id.get(row["pageid"]) or {}
        row["thumb"] = (page.get("thumbnail") or {}).get("source")


def search(query: str, limit: int = 8) -> list[dict]:
    """Search kits, prefix matches first.

    Three strategies, because none alone is enough. Full-text search ranks
    "RG Sazabi" below unrelated pages; prefix search finds the exact title
    (often via a redirect) but misses anything phrased differently; and
    neither can find a page the search index never picked up.
    """
    merged: dict[int, dict] = {}

    try:
        for row in _rows(_get({
            "action": "query",
            "generator": "prefixsearch",
            "gpssearch": query,
            "gpslimit": limit,
            **_COMMON_PROPS,
        })):
            merged.setdefault(row["pageid"], row)
    except LookupError:
        pass  # fall through to full-text; one failed strategy is not fatal

    for row in _rows(_get({
        "action": "query",
        "generator": "search",
        "gsrsearch": query,
        "gsrlimit": limit,
        **_COMMON_PROPS,
    })):
        merged.setdefault(row["pageid"], row)

    # Always scan the local title index as well. Gating this on "did the
    # indexed results look good enough?" fails quietly: searching "PG Astray
    # Green Frame" turns up the HGGS kit, which matches every word and so looks
    # like success, while the PG entry the user actually owns is absent from
    # the wiki's search index entirely. The index is cached for six hours, so
    # this costs one slow warm-up per day.
    for row in _title_scan(query, limit):
        merged.setdefault(row["pageid"], row)

    ranked = _rank(query, list(merged.values()), limit)
    _thumbs(ranked)
    for row in ranked:
        row.pop("_i", None)
    return ranked


def _split_params(body: str) -> list[str]:
    """Split a template body on top-level pipes.

    Values embed templates and links ({{refyentax}}, [[Foo]]) whose own pipes
    must not split a field, so track nesting instead of using str.split('|').
    """
    parts, depth, cur, i = [], 0, "", 0
    while i < len(body):
        pair = body[i:i + 2]
        if pair in ("{{", "[["):
            depth += 1
            cur += pair
            i += 2
            continue
        if pair in ("}}", "]]"):
            depth -= 1
            cur += pair
            i += 2
            continue
        ch = body[i]
        if ch == "|" and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
        i += 1
    parts.append(cur)
    return parts


# Editors write the template both ways, and MediaWiki treats underscore and
# space as the same title. Some pages also open with an unrelated banner
# template ({{LimitedItem}}), so match this template by name rather than
# assuming it is the first one on the page.
_INFOBOX_RE = re.compile(r"\{\{\s*Plamo[_ ]Infobox", re.I)


def _infobox(wikitext: str) -> dict:
    match = _INFOBOX_RE.search(wikitext)
    if not match:
        return {}
    start = match.start()

    depth, i = 0, start
    while i < len(wikitext):
        if wikitext[i:i + 2] == "{{":
            depth += 1
            i += 2
            continue
        if wikitext[i:i + 2] == "}}":
            depth -= 1
            i += 2
            if depth == 0:
                break
            continue
        i += 1

    body = wikitext[start + 2:i - 2]
    fields = {}
    for part in _split_params(body)[1:]:      # [0] is the template name
        key, sep, val = part.partition("=")
        if sep:
            fields[key.strip().lower()] = val.strip()
    return fields


def _clean(value: str) -> str:
    """Strip wiki markup down to plain text."""
    value = re.sub(r"\{\{[^}]*\}\}", "", value)              # {{refyentax}}
    value = re.sub(r"\[\[([^\]|]*\|)?([^\]]*)\]\]", r"\2", value)  # [[a|b]] -> b
    value = re.sub(r"''+", "", value)
    return re.sub(r"\s+", " ", value).strip()


def _grade(classification: str) -> str:
    c = classification.lower()
    if "perfect grade" in c:
        return "PG"
    if "master grade" in c:
        return "MG"
    if "real grade" in c:
        return "RG"
    if "high grade" in c:
        return "HG"
    if re.search(r"\bsd\b|super deformed", c):
        return "SD"
    return "Other"


def _scale(raw: str) -> str:
    """Only a real ratio counts — 'Non (Super Deformed)' is not a scale."""
    m = re.search(r"1\s*/\s*(\d+)", raw)
    return f"1/{m.group(1)}" if m else ""


def _image_url(filename: str) -> str | None:
    filename = _clean(filename).split(";")[0].strip()   # "X.jpg;Front" -> "X.jpg"
    if not filename:
        return None
    if not filename.lower().startswith("file:"):
        filename = "File:" + filename
    data = _get({
        "action": "query",
        "titles": filename,
        "prop": "imageinfo",
        "iiprop": "url",
    })
    for page in ((data.get("query") or {}).get("pages") or {}).values():
        info = (page.get("imageinfo") or [{}])[0]
        if info.get("url"):
            return info["url"]
    return None


def detail(pageid: int) -> dict:
    """Full kit record: grade, scale, series, price, box art."""
    data = _get({
        "action": "query",
        "pageids": pageid,
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "rvsection": 0,
    })
    pages = (data.get("query") or {}).get("pages") or {}
    page = pages.get(str(pageid))
    if not page:
        raise LookupError("page not found")

    try:
        wikitext = page["revisions"][0]["slots"]["main"]["*"]
    except (KeyError, IndexError):
        wikitext = ""

    # Safety net for a redirect id reaching here directly: search resolves
    # redirects, but a bookmarked or hand-typed id may not be resolved.
    redirect = re.match(r"#REDIRECT\s*\[\[([^\]]+)\]\]", wikitext.strip(), re.I)
    if redirect:
        hop = _get({
            "action": "query",
            "titles": redirect.group(1),
            "prop": "revisions",
            "rvprop": "content",
            "rvslots": "main",
            "rvsection": 0,
        })
        for target in ((hop.get("query") or {}).get("pages") or {}).values():
            try:
                wikitext = target["revisions"][0]["slots"]["main"]["*"]
                page = target
                pageid = target["pageid"]
            except (KeyError, IndexError):
                pass

    fields = _infobox(wikitext)
    if not fields:
        raise LookupError("that page is not a kit entry")

    classification = _clean(fields.get("classification", ""))
    title = page.get("title", "")

    return {
        "pageid": pageid,
        "title": title,
        "grade": _grade(classification),
        "classification": classification,
        "scale": _scale(fields.get("scale", "")),
        "series": _clean(fields.get("franchise", "")),
        "model_of": _clean(fields.get("model of", "")),
        # Japanese retail, kept as text. It is not a peso price and converting
        # it would invent a number — PH retail differs and FX moves.
        "price_jpy": _clean(fields.get("price", "")),
        "released": _clean(fields.get("release date", "")),
        "image": _image_url(fields.get("image", "")),
        "url": "https://gunpla.fandom.com/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
    }


def fetch_image(url: str) -> tuple[bytes, str]:
    """Download box art. Returns (data, extension).

    Every redirect hop is re-checked against the host allowlist — validating
    only the URL handed in would let an open redirect walk us somewhere else.
    """

    def check(u: str) -> None:
        parts = urllib.parse.urlparse(u)
        if parts.scheme != "https" or parts.hostname not in ALLOWED_IMAGE_HOSTS:
            raise LookupError(f"refusing to fetch from {parts.hostname or 'unknown host'}")

    check(url)

    class GuardedRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            check(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(GuardedRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with opener.open(req, timeout=TIMEOUT) as resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            ext = CONTENT_TYPE_EXT.get(ctype)
            if ext is None:
                raise LookupError(f"unsupported image type: {ctype or 'unknown'}")
            # Read one byte past the cap so an oversized file is detected
            # rather than silently truncated.
            data = resp.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise LookupError("image exceeds 8 MB")
            if not data:
                raise LookupError("empty image response")
            return data, ext
    except urllib.error.URLError as exc:
        raise LookupError(f"could not fetch image: {exc.reason}") from exc
