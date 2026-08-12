#!/usr/bin/env python3
"""
Gunpla Tracker — collection/build log for Gundam model kits.

Standalone Flask app, SQLite storage, no external services. Binds 0.0.0.0 so
it's reachable over Tailscale from a phone (useful for uploading build photos
straight from the workbench) — there's no auth, so keep it on the tailnet
only, same caution as nexus-home.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

import db
import lookup

ROOT = Path(__file__).parent
WEB = ROOT / "web"
UPLOADS = ROOT / "data" / "uploads"

HOST = "0.0.0.0"
PORT = 6060

ALLOWED_EXT = {"jpg", "jpeg", "png", "gif", "webp"}

app = Flask(__name__, static_folder=None)


def _kit_fields(data: dict) -> dict:
    """Pull + normalize kit fields from an incoming JSON body."""
    status = data.get("status", "wishlist")
    if status not in db.STATUSES:
        status = "wishlist"
    grade = data.get("grade", "Other")
    if grade not in db.GRADES:
        grade = "Other"

    def _num(key: str):
        val = data.get(key)
        if val in (None, ""):
            return None
        try:
            return float(val)
        except (TypeError, ValueError):
            return None

    return {
        "name": (data.get("name") or "").strip(),
        "grade": grade,
        "scale": (data.get("scale") or "").strip(),
        "series": (data.get("series") or "").strip(),
        "status": status,
        "price_msrp": _num("price_msrp"),
        "price_paid": _num("price_paid"),
        "store": (data.get("store") or "").strip(),
        "date_acquired": (data.get("date_acquired") or "").strip(),
        "notes": (data.get("notes") or "").strip(),
    }


def _photo_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "url": f"/uploads/{row['filename']}",
        "caption": row["caption"],
        "is_box_art": bool(row["is_box_art"]),
    }


@app.get("/api/kits")
def list_kits():
    status = request.args.get("status")
    conn = db.get_conn()
    try:
        if status and status in db.STATUSES:
            rows = conn.execute(
                "SELECT * FROM kits WHERE status = ? ORDER BY created_at DESC", (status,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM kits ORDER BY created_at DESC").fetchall()

        out = []
        for r in rows:
            kit = dict(r)
            art = conn.execute(
                "SELECT filename FROM photos WHERE kit_id = ? "
                "ORDER BY is_box_art DESC, sort_order ASC, id ASC LIMIT 1",
                (r["id"],),
            ).fetchone()
            kit["thumbnail"] = f"/uploads/{art['filename']}" if art else None
            kit["photo_count"] = conn.execute(
                "SELECT COUNT(*) c FROM photos WHERE kit_id = ?", (r["id"],)
            ).fetchone()["c"]
            out.append(kit)
        return jsonify(out)
    finally:
        conn.close()


@app.get("/api/kits/<int:kit_id>")
def get_kit(kit_id: int):
    conn = db.get_conn()
    try:
        row = conn.execute("SELECT * FROM kits WHERE id = ?", (kit_id,)).fetchone()
        if row is None:
            return jsonify({"error": "not found"}), 404
        kit = dict(row)
        photos = conn.execute(
            "SELECT * FROM photos WHERE kit_id = ? ORDER BY is_box_art DESC, sort_order ASC, id ASC",
            (kit_id,),
        ).fetchall()
        kit["photos"] = [_photo_row(p) for p in photos]
        return jsonify(kit)
    finally:
        conn.close()


@app.post("/api/kits")
def create_kit():
    fields = _kit_fields(request.get_json(force=True, silent=True) or {})
    if not fields["name"]:
        return jsonify({"error": "name is required"}), 400

    conn = db.get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO kits (name, grade, scale, series, status, price_msrp, "
            "price_paid, store, date_acquired, notes) VALUES "
            "(:name, :grade, :scale, :series, :status, :price_msrp, :price_paid, "
            ":store, :date_acquired, :notes)",
            fields,
        )
        conn.commit()
        return jsonify({"id": cur.lastrowid, **fields}), 201
    finally:
        conn.close()


@app.patch("/api/kits/<int:kit_id>")
def update_kit(kit_id: int):
    body = request.get_json(force=True, silent=True) or {}
    conn = db.get_conn()
    try:
        existing = conn.execute("SELECT * FROM kits WHERE id = ?", (kit_id,)).fetchone()
        if existing is None:
            return jsonify({"error": "not found"}), 404

        merged = {**dict(existing), **body}
        fields = _kit_fields(merged)
        if not fields["name"]:
            return jsonify({"error": "name is required"}), 400

        conn.execute(
            "UPDATE kits SET name=:name, grade=:grade, scale=:scale, series=:series, "
            "status=:status, price_msrp=:price_msrp, price_paid=:price_paid, "
            "store=:store, date_acquired=:date_acquired, notes=:notes WHERE id=:id",
            {**fields, "id": kit_id},
        )
        conn.commit()
        return jsonify({"id": kit_id, **fields})
    finally:
        conn.close()


@app.delete("/api/kits/<int:kit_id>")
def delete_kit(kit_id: int):
    conn = db.get_conn()
    try:
        photos = conn.execute(
            "SELECT filename FROM photos WHERE kit_id = ?", (kit_id,)
        ).fetchall()
        conn.execute("DELETE FROM kits WHERE id = ?", (kit_id,))
        conn.commit()
        for p in photos:
            (UPLOADS / p["filename"]).unlink(missing_ok=True)
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.post("/api/kits/<int:kit_id>/photos")
def upload_photo(kit_id: int):
    conn = db.get_conn()
    try:
        if conn.execute("SELECT 1 FROM kits WHERE id = ?", (kit_id,)).fetchone() is None:
            return jsonify({"error": "kit not found"}), 404

        file = request.files.get("photo")
        if file is None or not file.filename:
            return jsonify({"error": "photo file is required"}), 400

        ext = secure_filename(file.filename).rsplit(".", 1)[-1].lower() if "." in file.filename else ""
        if ext not in ALLOWED_EXT:
            return jsonify({"error": f"unsupported file type .{ext}"}), 400

        UPLOADS.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex}.{ext}"
        file.save(UPLOADS / filename)

        is_box_art = request.form.get("is_box_art") in ("1", "true", "on")
        caption = (request.form.get("caption") or "").strip()

        cur = conn.execute(
            "INSERT INTO photos (kit_id, filename, caption, is_box_art) VALUES (?, ?, ?, ?)",
            (kit_id, filename, caption, int(is_box_art)),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM photos WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(_photo_row(row)), 201
    finally:
        conn.close()


@app.get("/api/lookup")
def api_lookup():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"error": "query too short"}), 400
    try:
        return jsonify(lookup.search(q))
    except lookup.LookupError as exc:
        # 502: we're fine, the upstream wiki isn't. Lets the UI say so plainly
        # instead of blaming the user's input.
        return jsonify({"error": str(exc)}), 502


@app.get("/api/lookup/<int:pageid>")
def api_lookup_detail(pageid: int):
    try:
        return jsonify(lookup.detail(pageid))
    except lookup.LookupError as exc:
        return jsonify({"error": str(exc)}), 502


@app.post("/api/kits/<int:kit_id>/photos/from-url")
def import_photo(kit_id: int):
    """Import wiki art server-side. The URL is allowlisted in lookup.py."""
    body = request.get_json(force=True, silent=True) or {}
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "url is required"}), 400

    conn = db.get_conn()
    try:
        if conn.execute("SELECT 1 FROM kits WHERE id = ?", (kit_id,)).fetchone() is None:
            return jsonify({"error": "kit not found"}), 404

        try:
            data, ext = lookup.fetch_image(url)
        except lookup.LookupError as exc:
            return jsonify({"error": str(exc)}), 502

        UPLOADS.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex}.{ext}"
        (UPLOADS / filename).write_bytes(data)

        cur = conn.execute(
            "INSERT INTO photos (kit_id, filename, caption, is_box_art) VALUES (?, ?, ?, ?)",
            (kit_id, filename, (body.get("caption") or "").strip(),
             int(bool(body.get("is_box_art")))),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM photos WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(_photo_row(row)), 201
    finally:
        conn.close()


@app.delete("/api/photos/<int:photo_id>")
def delete_photo(photo_id: int):
    conn = db.get_conn()
    try:
        row = conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            return jsonify({"error": "not found"}), 404
        conn.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        conn.commit()
        (UPLOADS / row["filename"]).unlink(missing_ok=True)
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.get("/api/stats")
def stats():
    conn = db.get_conn()
    try:
        by_status = {
            r["status"]: r["c"]
            for r in conn.execute("SELECT status, COUNT(*) c FROM kits GROUP BY status")
        }
        spent = conn.execute(
            "SELECT COALESCE(SUM(price_paid), 0) s FROM kits WHERE status != 'wishlist'"
        ).fetchone()["s"]
        wishlist_value = conn.execute(
            "SELECT COALESCE(SUM(price_msrp), 0) s FROM kits WHERE status = 'wishlist'"
        ).fetchone()["s"]
        by_grade = {
            r["grade"]: r["c"]
            for r in conn.execute("SELECT grade, COUNT(*) c FROM kits GROUP BY grade")
        }
        return jsonify(
            {
                "by_status": by_status,
                "by_grade": by_grade,
                "total_kits": sum(by_status.values()),
                "backlog": by_status.get("owned", 0),
                "total_spent": round(spent, 2),
                "wishlist_value": round(wishlist_value, 2),
            }
        )
    finally:
        conn.close()


@app.get("/uploads/<path:filename>")
def uploaded_file(filename: str):
    return send_from_directory(UPLOADS, filename)


@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:asset>")
def static_asset(asset: str):
    return send_from_directory(WEB, asset)


if __name__ == "__main__":
    db.init_db()
    print(f"Gunpla Tracker → http://{HOST}:{PORT}")
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)
