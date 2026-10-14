"""LocalStore (SQLite + outbox) のユニットテスト。実 DB ファイルは tmp_path に作る。"""

from __future__ import annotations

from pathlib import Path

from collector.models import Metrics, PostMetrics
from collector.store import LocalStore, account_key


def make_metrics() -> Metrics:
    return Metrics(
        followers=100,
        following=5,
        posts=1,
        recent_posts=[
            PostMetrics(
                external_id="abc123",
                url="https://www.instagram.com/p/abc123/",
                posted_at="2026-07-01T00:00:00Z",
                media_type="image",
                caption_head="hello",
                likes=10,
                comments=2,
                views=None,
            )
        ],
        source="ig-web",
    )


def test_account_key_format():
    assert account_key("instagram", "example_account") == "instagram:example_account"


def test_save_and_reload_snapshot(tmp_path: Path):
    db_path = tmp_path / "local.sqlite"
    with LocalStore(db_path) as store:
        store.save_metrics("instagram", "example_account", "2026-07-05T02:15:00Z", make_metrics())

    with LocalStore(db_path) as store:
        rows = store._conn.execute("SELECT * FROM snapshots").fetchall()
        assert len(rows) == 1
        assert rows[0]["followers"] == 100

        post_rows = store._conn.execute("SELECT * FROM post_snapshots").fetchall()
        assert len(post_rows) == 1
        assert post_rows[0]["external_id"] == "abc123"
        assert post_rows[0]["likes"] == 10


def test_save_metrics_is_idempotent_on_same_key(tmp_path: Path):
    db_path = tmp_path / "local.sqlite"
    with LocalStore(db_path) as store:
        store.save_metrics("instagram", "example_account", "2026-07-05T02:15:00Z", make_metrics())
        store.save_metrics("instagram", "example_account", "2026-07-05T02:15:00Z", make_metrics())

        rows = store._conn.execute("SELECT * FROM snapshots").fetchall()
        assert len(rows) == 1  # 同じ (account_key, collected_at) は上書きされ増えない


def test_outbox_enqueue_and_flush(tmp_path: Path):
    db_path = tmp_path / "local.sqlite"
    with LocalStore(db_path) as store:
        outbox_id = store.enqueue_outbox({"snapshots": [], "runs": []}, "2026-07-05T02:15:00Z")
        pending = store.pending_outbox()
        assert len(pending) == 1
        assert pending[0][0] == outbox_id

        store.mark_outbox_sent([outbox_id])
        assert store.pending_outbox() == []


def test_audience_state_roundtrip():
    """audience_state (§2.1 頻度制御用) の保存・取得・上書き。"""
    with LocalStore(":memory:") as store:
        assert store.get_audience_last_fetched("example_account", "demographics") is None

        store.mark_audience_fetched("example_account", "demographics", "2026-07-05T02:15:00Z")
        assert (
            store.get_audience_last_fetched("example_account", "demographics")
            == "2026-07-05T02:15:00Z"
        )
        # kind ごとに独立して管理される
        assert store.get_audience_last_fetched("example_account", "online_followers") is None

        store.mark_audience_fetched("example_account", "demographics", "2026-07-12T02:15:00Z")
        assert (
            store.get_audience_last_fetched("example_account", "demographics")
            == "2026-07-12T02:15:00Z"
        )
