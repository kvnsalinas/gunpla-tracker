#!/usr/bin/env python3
"""Load a handful of demo kits — for screenshots and for poking at the UI
before you've entered anything real.

    python3 scripts/seed_demo.py          # add demo rows
    python3 scripts/seed_demo.py --reset  # wipe ALL kits first

--reset deletes every kit in the database, not just demo ones.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402

DEMO = [
    # name, grade, scale, series, status, msrp, paid, store, date
    ("RX-78-2 Gundam Ver. Ka", "MG", "1/100", "Mobile Suit Gundam",
     "built", 3200, 2950, "ZeonHobby", "2026-03-14"),
    ("MBF-P02 Gundam Astray Red Frame", "RG", "1/144", "Gundam SEED Astray",
     "building", 1850, 1750, "Great Toys Davao", "2026-05-02"),
    ("ZGMF-X10A Freedom Gundam Ver. 2.0", "MG", "1/100", "Gundam SEED",
     "owned", 3600, 3400, "Lazada", "2026-06-21"),
    ("RX-93 Nu Gundam", "RG", "1/144", "Char's Counterattack",
     "owned", 2100, 1990, "Shopee", "2026-07-08"),
    ("XXXG-01W Wing Gundam Zero EW", "MG", "1/100", "Endless Waltz",
     "wishlist", 3900, None, "", ""),
    ("PF-78-1 Perfect Gundam", "HG", "1/144", "Plamo-Kyo Shiro",
     "built", 950, 890, "Hobbes", "2026-02-11"),
    ("MSN-04 Sazabi Ver. Ka", "MG", "1/100", "Char's Counterattack",
     "wishlist", 6800, None, "", ""),
    ("RX-0 Unicorn Gundam Ver. Ka", "PG", "1/60", "Gundam Unicorn",
     "wishlist", 18500, None, "", ""),
    ("MS-06S Char's Zaku II", "HG", "1/144", "Mobile Suit Gundam",
     "built", 780, 720, "ZeonHobby", "2026-01-30"),
    ("Gundam Barbatos Lupus Rex", "HG", "1/144", "Iron-Blooded Orphans",
     "building", 1100, 1050, "Shopee", "2026-07-25"),
    ("SD Gundam EX-Standard Strike Freedom", "SD", "", "Gundam SEED Destiny",
     "owned", 650, 600, "Great Toys", "2026-06-02"),
    ("MSM-07S Z'Gok", "HG", "1/144", "Mobile Suit Gundam",
     "owned", 820, 799, "Lazada", "2026-07-30"),
]


def main() -> None:
    db.init_db()
    conn = db.get_conn()
    try:
        if "--reset" in sys.argv:
            conn.execute("DELETE FROM photos")
            conn.execute("DELETE FROM kits")
            conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('kits','photos')")
            print("wiped existing kits + photos")

        conn.executemany(
            "INSERT INTO kits (name, grade, scale, series, status, price_msrp, "
            "price_paid, store, date_acquired) VALUES (?,?,?,?,?,?,?,?,?)",
            DEMO,
        )
        conn.commit()
        print(f"inserted {len(DEMO)} demo kits")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
