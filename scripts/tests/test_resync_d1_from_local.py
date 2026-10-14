"""scripts/resync_d1_from_local.py のユニットテスト。

実行例:
    cd collector
    uv run pytest ../scripts/tests

実ネットワークアクセスは行わない (respx で /ingest をモックする)。
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx

from resync_d1_from_local import resync

from collector.store import LocalStore

BASE_URL = "https://fake-worker.example.workers.dev"


def _make_local_db_with_outbox(tmp_path: Path, n_rows: int) -> str:
    db_path = str(tmp_path / "local.sqlite")
    with LocalStore(db_path) as store:
        for i in range(n_rows):
            store.enqueue_outbox(
                {
                    "snapshots": [
                        {
                            "platform": "instagram",
                            "handle": f"acct{i}",
                            "collected_at": f"2026-07-0{i + 1}T02:15:00Z",
                            "followers": 100 + i,
                            "following": 1,
                            "posts": 1,
                            "source": "ig-web",
                            "recent_posts": [],
                        }
                    ],
                    "runs": [
                        {
                            "platform": "instagram",
                            "handle": f"acct{i}",
                            "ran_at": f"2026-07-0{i + 1}T02:15:00Z",
                            "status": "ok",
                            "followers": 100 + i,
                            "latency_ms": 100,
                        }
                    ],
                },
                f"2026-07-0{i + 1}T02:15:00Z",
            )
    return db_path


@pytest.mark.asyncio
async def test_resync_empty_outbox_is_noop(tmp_path: Path):
    db_path = _make_local_db_with_outbox(tmp_path, 0)

    success, failure = await resync(db_path, BASE_URL, "secret")

    assert (success, failure) == (0, 0)


@pytest.mark.asyncio
@respx.mock
async def test_resync_resends_all_outbox_rows_including_already_sent(tmp_path: Path):
    db_path = _make_local_db_with_outbox(tmp_path, 3)
    # 1件は「送信済み」を模擬する (outbox は sent=1 でも行を消さないため resync 対象になる)
    with LocalStore(db_path) as store:
        pending = store.pending_outbox()
        store.mark_outbox_sent([pending[0][0]])

    ingest_route = respx.post(f"{BASE_URL}/ingest").mock(return_value=httpx.Response(200, json={"ok": True}))

    success, failure = await resync(db_path, BASE_URL, "secret")

    assert (success, failure) == (3, 0)
    assert ingest_route.call_count == 3


@pytest.mark.asyncio
@respx.mock
async def test_resync_dry_run_does_not_call_ingest(tmp_path: Path):
    db_path = _make_local_db_with_outbox(tmp_path, 2)
    ingest_route = respx.post(f"{BASE_URL}/ingest").mock(return_value=httpx.Response(200, json={"ok": True}))

    success, failure = await resync(db_path, BASE_URL, "secret", dry_run=True)

    assert (success, failure) == (2, 0)
    assert not ingest_route.called


@pytest.mark.asyncio
@respx.mock
async def test_resync_continues_after_one_failure(tmp_path: Path):
    db_path = _make_local_db_with_outbox(tmp_path, 2)
    ingest_route = respx.post(f"{BASE_URL}/ingest").mock(
        side_effect=[httpx.Response(500), httpx.Response(200, json={"ok": True})]
    )

    success, failure = await resync(db_path, BASE_URL, "secret")

    assert (success, failure) == (1, 1)
    assert ingest_route.call_count == 2
