"""SQLite access for the gunpla tracker. Stdlib only, sqlite3."""

from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "gunpla.db"

STATUSES = ("wishlist", "owned", "building", "built")
GRADES = ("HG", "RG", "MG", "PG", "SD", "Other")

SCHEMA = """
CREATE TABLE IF NOT EXISTS kits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
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

CREATE TABLE IF NOT EXISTS photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_id      INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    caption     TEXT NOT NULL DEFAULT '',
    is_box_art  INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_kit ON photos(kit_id);
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
