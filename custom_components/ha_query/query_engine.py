"""Small, explicitly bounded read-only query engine for HA Query."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from math import isfinite
from time import monotonic

QUERY_TIMEOUT_SECONDS = 10


def sqlite_path(db_url: str) -> str:
    """Read a SQLAlchemy SQLite file URL; its database path is not URL-decoded."""
    if not db_url.startswith('sqlite:///'):
        raise ValueError('Only SQLite Recorder is supported')
    path = db_url[len('sqlite:///'):].split('?', 1)[0]
    if not path or path == ':memory:':
        raise ValueError('Recorder must use a file-backed SQLite database')
    return path


def latest_updates(db_path: str, entity_ids: list[str]) -> tuple[dict[str, float], float | None]:
    """Return most recent recorded change per entity and earliest retained row.

    Called in an executor. SQLite query_only + mode=ro prevent writes.
    """
    if not entity_ids:
        return {}, None
    uri = Path(db_path).resolve().as_uri() + '?mode=ro'
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    try:
        deadline = monotonic() + QUERY_TIMEOUT_SECONDS
        conn.set_progress_handler(lambda: int(monotonic() >= deadline), 1000)
        conn.execute('PRAGMA query_only=ON')
        conn.execute('PRAGMA busy_timeout=5000')
        # The global minimum is only a diagnostic, not proof of retention coverage.
        oldest = conn.execute('SELECT MIN(last_updated_ts) FROM states').fetchone()[0]
        results: dict[str, float] = {}
        for offset in range(0, len(entity_ids), 300):
            if monotonic() >= deadline:
                raise TimeoutError('Recorder query exceeded its execution budget')
            batch = entity_ids[offset:offset + 300]
            placeholders = ','.join('?' for _ in batch)
            # A correlated MAX can use the Recorder metadata_id/last_updated_ts index.
            sql = f'''SELECT m.entity_id,
                       (SELECT MAX(s.last_updated_ts) FROM states s
                        WHERE s.metadata_id = m.metadata_id)
                      FROM states_meta m WHERE m.entity_id IN ({placeholders})'''
            for entity_id, timestamp in conn.execute(sql, batch):
                if timestamp is not None:
                    results[entity_id] = float(timestamp)
        return results, float(oldest) if oldest is not None else None
    finally:
        conn.close()


def sort_and_limit(rows: list[dict], key: str | None, descending: bool, limit: int) -> list[dict]:
    """Stable, type-aware sorting with missing values last in both directions."""
    if key:
        present = [r for r in rows if r.get(key) is not None]
        missing = [r for r in rows if r.get(key) is None]
        def sort_key(row):
            value = row[key]
            if isinstance(value, (int, float, str)) and not isinstance(value, bool):
                try:
                    number = float(value)
                except (TypeError, ValueError, OverflowError):
                    pass
                else:
                    if isfinite(number):
                        return (0, number)
            return (1, str(value).casefold())
        present.sort(key=sort_key, reverse=descending)
        rows = present + missing
    return rows[:limit]


def utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
