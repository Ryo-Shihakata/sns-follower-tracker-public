"""token_refresh.py のテスト (docs/insights-reports-plan.md §2.4)。

実 API は叩かない。_try_refresh をモックし、token_state の状態遷移だけを検証する。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from collector.store import LocalStore
from collector.token_refresh import refresh_graph_tokens

ACCOUNTS = {"example_account": {"token": "ENV_TOKEN", "ig_user_id": "123"}}


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def test_first_run_seeds_state_and_refreshes():
    with LocalStore(":memory:") as store:
        with patch(
            "collector.token_refresh._try_refresh",
            new=AsyncMock(return_value=("NEW_TOKEN", 5184000)),
        ):
            tokens = asyncio.run(refresh_graph_tokens(ACCOUNTS, store))

        assert tokens == {"example_account": "NEW_TOKEN"}
        state = store.get_token_state("example_account")
        assert state is not None
        assert state["seed_token"] == "ENV_TOKEN"
        assert state["current_token"] == "NEW_TOKEN"
        assert state["refreshed_at"] is not None
        assert state["expires_at"] is not None


def test_recent_refresh_is_skipped():
    with LocalStore(":memory:") as store:
        store.save_token_state(
            "example_account", "ENV_TOKEN", "STORED_TOKEN", _iso(datetime.now(timezone.utc)), None
        )
        mock = AsyncMock(return_value=("SHOULD_NOT_BE_USED", 5184000))
        with patch("collector.token_refresh._try_refresh", new=mock):
            tokens = asyncio.run(refresh_graph_tokens(ACCOUNTS, store))

        mock.assert_not_awaited()
        assert tokens == {"example_account": "STORED_TOKEN"}


def test_stale_refresh_triggers_new_refresh():
    with LocalStore(":memory:") as store:
        old = datetime.now(timezone.utc) - timedelta(days=8)
        store.save_token_state("example_account", "ENV_TOKEN", "STORED_TOKEN", _iso(old), None)
        with patch(
            "collector.token_refresh._try_refresh",
            new=AsyncMock(return_value=("NEWER_TOKEN", 5184000)),
        ):
            tokens = asyncio.run(refresh_graph_tokens(ACCOUNTS, store))

        assert tokens == {"example_account": "NEWER_TOKEN"}


def test_env_token_change_resets_state():
    """ユーザーが .env を差し替えたら stored より env が勝つ。"""
    with LocalStore(":memory:") as store:
        store.save_token_state(
            "example_account", "OLD_ENV", "OLD_STORED", _iso(datetime.now(timezone.utc)), None
        )
        with patch(
            "collector.token_refresh._try_refresh", new=AsyncMock(return_value=None)
        ):
            tokens = asyncio.run(refresh_graph_tokens(ACCOUNTS, store))

        # refresh 失敗でも env の新トークンが使われる
        assert tokens == {"example_account": "ENV_TOKEN"}
        state = store.get_token_state("example_account")
        assert state is not None and state["seed_token"] == "ENV_TOKEN"


def test_refresh_failure_keeps_current_token():
    with LocalStore(":memory:") as store:
        old = datetime.now(timezone.utc) - timedelta(days=30)
        store.save_token_state("example_account", "ENV_TOKEN", "STORED_TOKEN", _iso(old), None)
        with patch(
            "collector.token_refresh._try_refresh", new=AsyncMock(return_value=None)
        ):
            tokens = asyncio.run(refresh_graph_tokens(ACCOUNTS, store))

        assert tokens == {"example_account": "STORED_TOKEN"}
