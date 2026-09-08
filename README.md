# GUNPLA REGISTRY

A cockpit-HUD themed collection and build-status tracker for Gundam model kits.
Runs on Cloudflare Workers with D1 and R2. Multi-user: every pilot signs in and
sees only their own hangar. No frontend framework, no CDN, no build step.

> Track what you own, what you're building, what you've finished, and what's
> still on the wishlist. Plus the number every gunpla builder pretends not to
> think about: your **build clear rate**.

![status](https://img.shields.io/badge/stack-Workers%20%2B%20D1%20%2B%20R2-3dfd9f?style=flat-square)
![deps](https://img.shields.io/badge/frontend%20dependencies-0-3dfd9f?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-3dfd9f?style=flat-square)

## Why this exists

I collect Gunpla and I lose track of it. Which kits are in the stash, which
one I'm mid-build on, what I actually paid versus what the box says, and
whether I already own the thing I'm about to buy again. A spreadsheet handles
none of that well once photos are involved.

It's open source because the interesting part turned out not to be the CRUD.
It was discovering that **the obvious data source is the wrong one** — the
Gundam wiki catalogues fictional mobile suits, not the plastic on your shelf —
and then that **the right wiki's search index is missing real kits**, which no
amount of better queries can fix. Both problems are written up below with the
evidence, because anyone else building a Gunpla tool will hit them and the
failure mode is silent: you get plausible results and never notice the kit you
own isn't among them.

## Features

- **Private per-pilot registries** — sign up with a callsign and a password and
  your collection is yours alone. No email, no confirmation step, nothing to
  verify. Every query is scoped to the signed-in user, and another account
  asking for your kit gets a 404, not a 403.
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

## Running it locally

```bash
npm install
npx wrangler d1 create gunpla        # paste the printed id into wrangler.toml
npm run db:migrate:local
npm run dev
```

Then open **http://localhost:8787** and register a pilot. `wrangler dev` runs
the real Worker against a local D1 and R2, so local behaviour matches
production — there is no separate dev server to keep in sync.

Want demo data to look at first? The seeder emits SQL for one pilot, so
register that account first:

```bash
node scripts/seed-demo.mjs <username> > /tmp/seed.sql
npx wrangler d1 execute gunpla --local --file=/tmp/seed.sql
```

(`--reset` wipes that pilot's kits before inserting. It deletes *everything*
they own, not just demo rows. Other pilots are untouched.)

## Deploying it

```bash
npx wrangler r2 bucket create gunpla-photos
npm run db:migrate:remote
npx wrangler secret put SIGNUP_CODE   # optional, see below
npx wrangler deploy
```

That publishes to `https://gunpla-tracker.<your-subdomain>.workers.dev`. The
free tier covers a personal registry comfortably — D1 gives 5 GB of storage,
R2 gives 10 GB, and photos are the only thing that grows.

To put it on your own domain, add a route in `wrangler.toml` for a zone on
your Cloudflare account.

## A note on security

The app is built to be reachable from the public internet, which the previous
Flask version explicitly was not.

- **Passwords** are hashed with PBKDF2-SHA256 (100k iterations, per-user salt)
  via WebCrypto. The stored format carries its own iteration count, so the cost
  can be raised later without invalidating existing passwords.
- **Sessions** are opaque 256-bit random tokens in an `HttpOnly; Secure;
  SameSite=Lax` cookie, with the authoritative record in D1 — so signing out
  actually revokes the session rather than just dropping the cookie.
- **Isolation** is enforced in the `WHERE` clause of every query, never as a
  separate ownership check that a new route could forget. Photos are served
  through the Worker rather than from a public bucket, so an R2 key alone
  doesn't grant access.
- **Signup** is open by default. If you'd rather it not be, set a
  `SIGNUP_CODE` secret and registration requires it:

  ```bash
  npx wrangler secret put SIGNUP_CODE
  ```

  With no secret set, anyone who finds the URL can create an account. For a
  registry shared with a couple of friends, set one.

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
titles, six-hour cache in the Workers Cache API, ~11s to warm up, then ~2s per
query) and ranks against that, merging in full-text results for content
matches. Coverage no longer depends on what Fandom indexed.

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
surface: the URL arrives over the wire. `worker/lookup.ts` allowlists the
wiki's CDN host, follows redirects manually so it can re-check **every hop**
against that allowlist, requires an image content-type, and caps downloads at
8 MB.

Images are fetched from the wiki at runtime; none are redistributed in this
repository.

## Data model

| Table | Purpose |
|---|---|
| `users` | callsign, display name, PBKDF2 password hash |
| `sessions` | one row per sign-in; deleted on logout and swept when expired |
| `kits` | `user_id` owner, plus name, grade, scale, series, status, MSRP, price paid, store, date acquired, notes |
| `photos` | many per kit; `filename` is an R2 object key; `is_box_art` picks the card thumbnail |

Photos reach ownership through their kit rather than carrying a `user_id` of
their own, so there is exactly one place a kit can change hands. Deletes cascade
in application code rather than via `ON DELETE CASCADE`: D1 doesn't reliably
enforce it across statements, and the R2 blobs need cleaning up regardless.

There's deliberately no build-log timeline yet — status plus a photo gallery
covers the common case. If per-session WIP notes become useful, that's a
`build_log` table (`kit_id`, `date`, `note`, `photo_id`) and a tab in the
detail view.

## Layout

```
wrangler.toml          Worker config: D1, R2 and static-asset bindings
worker/index.ts        router; /api/* and /uploads/*, else the static site
worker/auth.ts         signup, login, sessions, PBKDF2 hashing
worker/kits.ts         kit + photo routes, all scoped to the signed-in user
worker/lookup.ts       gunpla.fandom.com client + SSRF-guarded image fetch
worker/db.ts           shared types, constants, field coercion
migrations/            D1 schema
scripts/seed-demo.mjs  demo rows for screenshots
web/index.html         single page
web/style.css          the cockpit design system
web/app.js             no dependencies, no build step
web/fonts/             self-hosted VT323 (OFL)
```

The Worker is TypeScript; the frontend is deliberately still plain ES5-era
browser JS served verbatim, with no bundler between what's in the repo and what
the browser runs.

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
