"""
query_history.py — SQLite-backed SOQL query history for sf_fls_exporter.
"""

import sqlite3
from pathlib import Path
from platform_env import avio_data_dir

_QUERY_HISTORY_DB  = avio_data_dir() / "query_history.db"
_QUERY_HISTORY_MAX = 200   # keep last N queries


def _qh_connect():
    """Open (or create) the query history DB and ensure the schema exists."""
    con = sqlite3.connect(str(_QUERY_HISTORY_DB))
    con.execute("""
        CREATE TABLE IF NOT EXISTS query_history (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            org       TEXT    NOT NULL DEFAULT '',
            soql      TEXT    NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            ran_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        )
    """)
    con.commit()
    return con


def _qh_save(org: str, soql: str, row_count: int):
    """Append a query run to history, pruning oldest beyond MAX."""
    try:
        con = _qh_connect()
        con.execute(
            "INSERT INTO query_history (org, soql, row_count, ran_at) VALUES (?,?,?,datetime('now','localtime'))",
            (org, soql.strip(), row_count),
        )
        con.execute(f"""
            DELETE FROM query_history WHERE id NOT IN (
                SELECT id FROM query_history ORDER BY id DESC LIMIT {_QUERY_HISTORY_MAX}
            )
        """)
        con.commit()
        con.close()
    except Exception:
        pass


def _qh_load(org: str = "", limit: int = 50) -> list:
    """Return recent history rows as dicts, newest first."""
    try:
        con = _qh_connect()
        if org:
            cur = con.execute(
                "SELECT id, org, soql, row_count, ran_at FROM query_history "
                "WHERE org=? ORDER BY id DESC LIMIT ?", (org, limit))
        else:
            cur = con.execute(
                "SELECT id, org, soql, row_count, ran_at FROM query_history "
                "ORDER BY id DESC LIMIT ?", (limit,))
        rows = [{"id": r[0], "org": r[1], "soql": r[2],
                 "row_count": r[3], "ran_at": r[4]} for r in cur.fetchall()]
        con.close()
        return rows
    except Exception:
        return []


def _qh_delete(row_id: int):
    try:
        con = _qh_connect()
        con.execute("DELETE FROM query_history WHERE id=?", (row_id,))
        con.commit()
        con.close()
    except Exception:
        pass


def _qh_clear(org: str = ""):
    try:
        con = _qh_connect()
        if org:
            con.execute("DELETE FROM query_history WHERE org=?", (org,))
        else:
            con.execute("DELETE FROM query_history")
        con.commit()
        con.close()
    except Exception:
        pass
