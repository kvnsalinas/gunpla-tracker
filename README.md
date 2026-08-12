# GUNPLA REGISTRY

A cockpit-HUD themed collection and build-status tracker for Gundam model kits.
Flask + SQLite, no framework, no CDN, no external services — clone it and run it.

> Track what you own, what you're building, what you've finished, and what's
> still on the wishlist. Plus the number every gunpla builder pretends not to
> think about: your **build clear rate**.

![status](https://img.shields.io/badge/stack-Flask%20%2B%20SQLite-3dfd9f?style=flat-square)
![deps](https://img.shields.io/badge/JS%20dependencies-0-3dfd9f?style=flat-square)

## Features

- **Kit lookup with box art** — type `RG Sazabi`, hit LOOKUP, pick from the
  results. Grade, scale, series, JP retail price and the official **box art**
  are filled in for you. See [below](#where-the-kit-data-comes-from).
- **Four-stage pipeline** — wishlist → stash → building → built, changeable in
  one click from the detail view.
- **Scale follows grade** — HG/RG → 1/144, MG → 1/100, PG → 1/60, SD →
  non-scale. A scale you typed yourself is never overwritten.
- **Grade-aware** — HG / RG / MG / PG / SD each get their own accent color, and
  sorting by grade orders them PG → MG → RG → HG → SD, not alphabetically.
- **Photo gallery per kit** — drag-drop, paste from clipboard, or browse. Flag
  one as box art and it becomes the card thumbnail. Click any photo for a
  lightbox.
- **Money tracking** — MSRP vs. what you actually paid, total spent, and the
  standing value of your wishlist.
- **Build clear rate** — built ÷ kits actually acquired. Wishlist items are
  excluded; something you haven't bought isn't backlog yet.
- **Instant search + sort** — the whole collection loads once and filters
  client-side, so typing is zero-latency.
- **Cockpit boot sequence** — a ~3.7s power-on animation with a scanning
  reticle, boot log, and shutters that split apart to reveal the dashboard.
  Plays once per browser session, skippable, and disabled entirely under
  `prefers-reduced-motion`.
- **Keyboard driven** — `N` new unit, `/` search, `Esc` close.
- **Responsive** — 6-across on desktop, 2-across on a phone at the workbench.

## Running it

```bash
pip install -r requirements.txt
python3 app.py
```

Then open **http://localhost:6060**.

Want demo data to look at first?

```bash
python3 scripts/seed_demo.py
```

(`--reset` wipes all kits before inserting. It deletes *everything*, not just
demo rows.)

## Running it as a service (Linux, systemd)

```bash
systemctl --user enable --now gunpla-tracker
```

See [`deploy/gunpla-tracker.service`](deploy/gunpla-tracker.service) — copy it
to `~/.config/systemd/user/` and set `WorkingDirectory` and the interpreter
path. Use an **absolute** interpreter path; if you use pyenv, point at
`~/.pyenv/versions/<v>/bin/python3`, not the shim, since systemd doesn't build
PATH the way a login shell does.

## A note on security

`app.py` binds `0.0.0.0` so you can reach it from your phone over a private
network (I use [Tailscale](https://tailscale.com) — handy for uploading WIP
photos straight from the workbench).

**There is no authentication.** Anyone who can reach the port can read, edit,
and delete your collection and upload files. Keep it on a private network or
tailnet. Do not port-forward it or put it behind a public tunnel without
putting real auth in front of it first. To lock it to the local machine only,
change `HOST` in `app.py` to `127.0.0.1`.

## Where the kit data comes from

Lookup queries **[gunpla.fandom.com](https://gunpla.fandom.com)** — the Gunpla
Builders wiki, which catalogues Bandai *kits*: one page per product, each with
a `Plamo_Infobox` holding box art, classification, scale, franchise, release
date and JP retail price.

Notably **not** `gundam.fandom.com`. That wiki catalogues *mobile suits* —
in-universe machines — so it returns anime lineart and has no concept of a
grade, a scale, or a box. It's the obvious place to look and it's the wrong
one.

### Why search doesn't just call the wiki's search

**The wiki's own search index is incomplete.** The MG Wing Zero EW Ver.Ka page
is not in it — searching its *exact title* returns nothing — yet
`list=allpages` enumerates it fine. Relying on the search endpoint silently
loses real kits.

It also can't be detected by "did we get good results?". Searching
`PG Astray Green Frame` returns the **HGGS** kit, which matches every word and
looks like success, while the PG entry you actually own is missing.

So the lookup keeps a **local index of every article on the wiki** (~2,500
titles, six-hour cache, ~11s to warm up, then ~2s per query) and ranks against
that, merging in full-text results for content matches. Coverage no longer
depends on what Fandom indexed.

Ranking then has to survive titles carrying a model number you'd never type
(`MG Wing Zero EW Ver Ka` → `MG XXXG-00W0 Wing Gundam Zero EW (Ver.Ka)`):

- Words are split into **distinctive** and **generic**. Matching `sazabi`
  counts; matching `gundam`, `clear`, `ver`, or `frame` barely does. Before
  this, "RG Sazabi Clear Color" surfaced Strike Freedom and RX-78F00 — both
  merely "clear" kits.
- A result must share **at least one distinctive word**, which is what stops
  `RG Sazabi` from returning a Gelgoog Menace and a Moon Gundam rifle.
- A matching grade prefix wins ties, then shorter titles, so the base kit
  outranks its coating variants.
- Grade/lineup overview pages (`Real Grade`, `Master Grade`) are dropped
  outright rather than sorted to the bottom.

### What is *not* auto-filled

- **What you paid.** JP retail is captured as a reference note, never as a
  peso figure — PH retail differs and converting would invent a number.
- **Your status, store, and date.** Those are facts about you, not the kit.

### Prices

There's no usable price API. Bandai publishes none, and neither do the PH
retailers (ZeonHobby, MyHobbyPlace, Hobbes, et al). Scraping a shop breaks
silently whenever they touch their markup, and is legally grey besides. So the
peso figures are yours to enter, and each kit's detail view has a **CHECK
PRICE** link that opens a search for that kit's name.

### Fetching images safely

Box art is downloaded server-side, which makes the import endpoint an SSRF
surface: the URL arrives over the wire. `lookup.py` allowlists the wiki's CDN
host, re-checks **every redirect hop** against that allowlist, requires an
image content-type, and caps downloads at 8 MB.

Images are fetched from the wiki at runtime; none are redistributed in this
repository.

## Data model

| Table | Purpose |
|---|---|
| `kits` | name, grade, scale, series, status, MSRP, price paid, store, date acquired, notes |
| `photos` | many per kit; `is_box_art` picks the card thumbnail; `ON DELETE CASCADE` |

There's deliberately no build-log timeline yet — status plus a photo gallery
covers the common case. If per-session WIP notes become useful, that's a
`build_log` table (`kit_id`, `date`, `note`, `photo_id`) and a tab in the
detail view.

## Layout

```
app.py               Flask API + static serving
db.py                schema, connection helper (stdlib sqlite3)
lookup.py            gunpla.fandom.com client + SSRF-guarded image fetch
scripts/seed_demo.py demo rows for screenshots
deploy/              systemd unit template
web/index.html       single page
web/style.css        the cockpit design system
web/app.js           ~450 lines, no dependencies
web/fonts/           self-hosted VT323 (OFL)
data/gunpla.db       your collection (gitignored)
data/uploads/        your photos (gitignored)
```

### Design notes

Two typefaces on purpose: **VT323** for HUD chrome, numerals, and labels, and
the system monospace stack for body copy — VT323 is lovely as an accent and
genuinely hard to read at paragraph size.

Panels use `clip-path` for cut corners rather than `border-radius`, because
mecha panel lines are angular. Status uses both color *and* a text label, so
it survives color-blindness and grayscale.

## License

MIT — see [LICENSE](LICENSE). Gundam and Gunpla are trademarks of Bandai
Namco; this is an unaffiliated personal tool that ships no Bandai assets.
