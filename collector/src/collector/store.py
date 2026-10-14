"""自宅ローカル SQLite ストア (docs/implementation-plan.md §4.2)。

D1 の snapshots/post_snapshots 相当を account_key ('platform:handle') 形式で保持し、
D1 への送信キュー (outbox) も同じ DB に持つ。D1 が正、ローカルは
(a) 送信前 outbox、(b) 冗長バックアップという位置づけ。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from collector.models import Metrics

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS snapshots (
  account_key TEXT NOT NULL, collected_at TEXT NOT NULL,
  followers INTEGER NOT NULL, following INTEGER, posts INTEGER, source TEXT,
  PRIMARY KEY (account_key, collected_at));
CREATE TABLE IF NOT EXISTS post_snapshots (
  account_key TEXT NOT NULL, external_id TEXT NOT NULL, collected_at TEXT NOT NULL,
  url TEXT, posted_at TEXT, media_type TEXT, caption_head TEXT,
  likes INTEGER, comments INTEGER, views INTEGER, source TEXT,
  PRIMARY KEY (account_key, external_id, collected_at));
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS token_state (
  handle TEXT PRIMARY KEY,
  seed_token TEXT NOT NULL,
  current_token TEXT NOT NULL,
  refreshed_at TEXT,
  expires_at TEXT);
CREATE TABLE IF NOT EXISTS audience_state (
  handle TEXT NOT NULL,
  kind TEXT NOT NULL,
  last_fetched_at TEXT,
  PRIMARY KEY (handle, kind));
"""


def account_key(platform: str, handle: str) -> str:
    return f"{platform}:{handle}"


class LocalStore:
    """ローカル SQLite への読み書きをまとめるクラス。

    冪等性: (account_key, collected_at) / (account_key, external_id, collected_at)
    が PRIMARY KEY なので INSERT OR REPLACE で再実行しても安全 (D1 側の
    UNIQUE + ON CONFLICT DO NOTHING と同様の考え方)。
    """

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = Path(db_path)
        if str(self._db_path) != ":memory:":
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._db_path))
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript(SCHEMA_SQL)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "LocalStore":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # -- snapshots / post_snapshots -----------------------------------------

    def save_metrics(self, platform: str, handle: str, collected_at: str, metrics: Metrics) -> None:
        key = account_key(platform, handle)
        self._conn.execute(
            """
            INSERT OR REPLACE INTO snapshots
                (account_key, collected_at, followers, following, posts, source)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (key, collected_at, metrics.followers, metrics.following, metrics.posts, metrics.source),
        )
        for post in metrics.recent_posts:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO post_snapshots
                    (account_key, external_id, collected_at, url, posted_at, media_type,
                     caption_head, likes, comments, views, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    key,
                    post.external_id,
                    collected_at,
                    post.url,
                    post.posted_at,
                    post.media_type,
                    post.caption_head,
                    post.likes,
                    post.comments,
                    post.views,
                    metrics.source,
                ),
            )
        self._conn.commit()

    # -- outbox ---------------------------------------------------------------

    def enqueue_outbox(self, payload: dict[str, Any], created_at: str) -> int:
        cursor = self._conn.execute(
            "INSERT INTO outbox (payload_json, created_at, sent) VALUES (?, ?, 0)",
            (json.dumps(payload, ensure_ascii=False), created_at),
        )
        self._conn.commit()
        assert cursor.lastrowid is not None
        return cursor.lastrowid

    def pending_outbox(self) -> list[tuple[int, dict[str, Any]]]:
        rows = self._conn.execute(
            "SELECT id, payload_json FROM outbox WHERE sent = 0 ORDER BY id"
        ).fetchall()
        return [(row["id"], json.loads(row["payload_json"])) for row in rows]

    def all_outbox(self) -> list[tuple[int, dict[str, Any]]]:
        """sent フラグを問わず outbox の全行を返す。

        outbox は送信済みでも行を消さない設計のため、実質的に全送信履歴のログとして
        使える。`scripts/resync_d1_from_local.py` が D1 再構築のために使う。
        """
        rows = self._conn.execute("SELECT id, payload_json FROM outbox ORDER BY id").fetchall()
        return [(row["id"], json.loads(row["payload_json"])) for row in rows]

    def mark_outbox_sent(self, ids: list[int]) -> None:
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        self._conn.execute(
            f"UPDATE outbox SET sent = 1 WHERE id IN ({placeholders})", ids
        )
        self._conn.commit()

    # -- token_state (Graph API トークンの自動refresh 用) ----------------------

    def get_token_state(self, handle: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT handle, seed_token, current_token, refreshed_at, expires_at"
            " FROM token_state WHERE handle = ?",
            (handle,),
        ).fetchone()
        return dict(row) if row else None

    def save_token_state(
        self,
        handle: str,
        seed_token: str,
        current_token: str,
        refreshed_at: str | None,
        expires_at: str | None,
    ) -> None:
        self._conn.execute(
            """
            INSERT OR REPLACE INTO token_state
                (handle, seed_token, current_token, refreshed_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (handle, seed_token, current_token, refreshed_at, expires_at),
        )
        self._conn.commit()

    # -- audience_state (フォロワー属性/online_followers の頻度制御用、§2.1) ---------

    def get_audience_last_fetched(self, handle: str, kind: str) -> str | None:
        """`kind` ("demographics" | "online_followers") の前回取得時刻を返す。未取得なら None。"""
        row = self._conn.execute(
            "SELECT last_fetched_at FROM audience_state WHERE handle = ? AND kind = ?",
            (handle, kind),
        ).fetchone()
        return row["last_fetched_at"] if row else None

    def mark_audience_fetched(self, handle: str, kind: str, fetched_at: str) -> None:
        self._conn.execute(
            """
            INSERT OR REPLACE INTO audience_state (handle, kind, last_fetched_at)
            VALUES (?, ?, ?)
            """,
            (handle, kind, fetched_at),
        )
        self._conn.commit()
