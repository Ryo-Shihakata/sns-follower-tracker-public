"""C2 統合テスト: モック HTTP サーバー (respx) 相手に /accounts -> 収集 -> /ingest を通す。

実ネットワークアクセスは一切行わない。respx が httpx の呼び出しを差し替える。
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from collector.config import Settings
from collector.main import run_full
from collector.models import Metrics, PostMetrics

BASE_URL = "https://fake-worker.example.workers.dev"

# worker の実レスポンス形状に合わせる: /accounts /settings はラップ形式で返る (§5.5)
ACCOUNTS_RESPONSE = {
    "accounts": [
        {"id": 1, "platform_id": "instagram", "handle": "acct1", "display_name": None, "active": 1, "managed": 0},
        {"id": 2, "platform_id": "instagram", "handle": "acct2", "display_name": None, "active": 1, "managed": 0},
    ]
}

SETTINGS_RESPONSE = {
    "settings": {
        "jitter_min_seconds": "0",
        "jitter_max_seconds": "0",
        "anomaly_pct_threshold": "0.10",
        "anomaly_abs_min": "50",
        "freshness_hours": "30",
    }
}


class _FakeSucceedingCollector:
    """常に成功するダミー Collector (実 Instagram/curl_cffi には触れない)。"""

    platform_id = "instagram"

    async def fetch(self, handle: str) -> Metrics:
        return Metrics(
            followers=1000,
            following=5,
            posts=10,
            recent_posts=[
                PostMetrics(
                    external_id=f"{handle}-post1",
                    url=f"https://www.instagram.com/p/{handle}-post1/",
                    posted_at="2026-07-01T00:00:00Z",
                    media_type="image",
                    caption_head="hello",
                    likes=42,
                    comments=3,
                    views=None,
                )
            ],
            source="ig-web",
        )


class _FakeFailingCollector:
    """常に失敗するダミー Collector (全滅シナリオ用)。"""

    platform_id = "instagram"

    async def fetch(self, handle: str) -> Metrics:
        raise RuntimeError(f"simulated failure for {handle}")


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        workers_base_url=BASE_URL,
        ingest_secret="test-secret",
        youtube_api_key=None,
        ig_sessionid=None,
        local_db_path=str(tmp_path / "local.sqlite"),
        log_level="INFO",
    )


@pytest.mark.asyncio
@respx.mock
async def test_full_run_sends_ingest_payload_matching_contract(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "collector.main.build_collectors", lambda settings: {"instagram": _FakeSucceedingCollector()}
    )
    monkeypatch.setattr("collector.main.asyncio.sleep", _no_sleep)

    respx.get(f"{BASE_URL}/accounts").mock(
        return_value=httpx.Response(200, json=ACCOUNTS_RESPONSE)
    )
    respx.get(f"{BASE_URL}/settings").mock(
        return_value=httpx.Response(200, json=SETTINGS_RESPONSE)
    )
    ingest_route = respx.post(f"{BASE_URL}/ingest").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    exit_code = await run_full(_settings(tmp_path))

    assert exit_code == 0
    assert ingest_route.called
    assert ingest_route.call_count == 1

    sent_body = json.loads(ingest_route.calls[0].request.content)
    assert set(sent_body.keys()) == {"snapshots", "runs"}
    assert len(sent_body["snapshots"]) == 2
    assert len(sent_body["runs"]) == 2

    snap = sent_body["snapshots"][0]
    assert snap["platform"] == "instagram"
    assert snap["handle"] in {"acct1", "acct2"}
    assert snap["followers"] == 1000
    assert snap["source"] == "ig-web"
    post = snap["recent_posts"][0]
    assert set(post.keys()) == {
        "external_id", "url", "posted_at", "media_type", "caption_head", "caption_full",
        "thumbnail_url", "likes", "comments", "views", "reach", "impressions", "saved",
        # docs/insights-reports-plan.md §2.1 (Graph API 経路のみ値が入る。web は None)
        "follows", "profile_visits", "shares", "total_interactions",
        "avg_watch_time_ms", "total_watch_time_ms",
    }

    run = sent_body["runs"][0]
    assert run["status"] == "ok"
    assert run["followers"] == 1000

    # 認証ヘッダも確認 (書込系 = INGEST_SECRET の Bearer)
    assert ingest_route.calls[0].request.headers["Authorization"] == "Bearer test-secret"


@pytest.mark.asyncio
@respx.mock
async def test_all_failures_aborts_before_calling_ingest(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "collector.main.build_collectors", lambda settings: {"instagram": _FakeFailingCollector()}
    )
    monkeypatch.setattr("collector.main.asyncio.sleep", _no_sleep)

    respx.get(f"{BASE_URL}/accounts").mock(
        return_value=httpx.Response(200, json=ACCOUNTS_RESPONSE)
    )
    respx.get(f"{BASE_URL}/settings").mock(
        return_value=httpx.Response(200, json=SETTINGS_RESPONSE)
    )
    ingest_route = respx.post(f"{BASE_URL}/ingest").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    exit_code = await run_full(_settings(tmp_path))

    assert exit_code == 1
    assert not ingest_route.called  # 全滅時は /ingest を呼ばない (IPを焼かない)

    # ローカルの outbox にはこの run 分が未送信のまま残っている
    from collector.store import LocalStore

    with LocalStore(_settings(tmp_path).local_db_path) as store:
        pending = store.pending_outbox()
        assert len(pending) == 1
        assert pending[0][1]["runs"][0]["status"] == "fail"


async def _no_sleep(_seconds: float) -> None:
    return None
