-- Gunpla Tracker schema. Ported from the original single-tenant SQLite
-- schema in db.py, with per-user ownership added: every kit belongs to
-- exactly one user, and photos reach ownership through their kit.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE kits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL REFERENCES users(id),
    name          TEXT NOT NULL,
    grade         TEXT NOT NULL DEFAULT 'Other',
    scale         TEXT NOT NULL DEFAULT '',
    series        TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'wishlist',
    price_msrp    REAL,
    price_paid    REAL,
    store         TEXT NOT NULL DEFAULT '',
    date_acquired TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_kits_user ON kits(user_id, status);

-- filename holds an R2 object key (u/<user_id>/<uuid>.<ext>), not a local path.
CREATE TABLE photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_id      INTEGER NOT NULL REFERENCES kits(id),
    filename    TEXT NOT NULL,
    caption     TEXT NOT NULL DEFAULT '',
    is_box_art  INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_photos_kit ON photos(kit_id);
