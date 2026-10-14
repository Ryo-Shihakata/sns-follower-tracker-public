"""managed アカウントへの Graph collector 割り当て/フォールバックのテスト
(docs/dashboard-v3-plan.md §4.3)。

- IG_GRAPH_TOKEN/IG_GRAPH_USER_ID 未設定なら managed アカウントを含む全アカウントが
  既存の web collector に割り当てられること (フォールバックが壊れていないこと)。
- 設定済みなら managed=1 かつ該当 handle のアカウントだけ Graph collector が
  選ばれ、他は従来どおり web collector が選ばれること。
"""

from __future__ import annotations

from collector.config import DEFAULT_IG_GRAPH_HANDLE, Settings
from collector.platforms.instagram import InstagramCollector
from collector.platforms.instagram_graph import InstagramGraphCollector
from collector.platforms.registry import build_collectors, build_graph_collectors, select_collector

ACCOUNTS = [
    {"id": 1, "platform_id": "instagram", "handle": DEFAULT_IG_GRAPH_HANDLE, "active": 1, "managed": 1},
    {"id": 2, "platform_id": "instagram", "handle": "other_account", "active": 1, "managed": 0},
]


def _settings(*, with_graph_token: bool) -> Settings:
    return Settings(
        workers_base_url="https://fake-worker.example.workers.dev",
        ingest_secret="test-secret",
        youtube_api_key=None,
        ig_sessionid=None,
        local_db_path=":memory:",
        log_level="INFO",
        ig_graph_token="fake-long-lived-token" if with_graph_token else None,
        ig_graph_user_id="17841400000000000" if with_graph_token else None,
    )


def test_no_graph_token_falls_back_to_web_collector_for_all_accounts():
    settings = _settings(with_graph_token=False)
    collectors = build_collectors(settings)
    graph_collectors = build_graph_collectors(settings)

    assert graph_collectors == {}

    for account in ACCOUNTS:
        chosen = select_collector(account, collectors, graph_collectors)
        assert isinstance(chosen, InstagramCollector)


def test_graph_token_set_selects_graph_collector_only_for_managed_handle():
    settings = _settings(with_graph_token=True)
    collectors = build_collectors(settings)
    graph_collectors = build_graph_collectors(settings)

    assert set(graph_collectors.keys()) == {DEFAULT_IG_GRAPH_HANDLE}

    managed_account, other_account = ACCOUNTS
    chosen_managed = select_collector(managed_account, collectors, graph_collectors)
    chosen_other = select_collector(other_account, collectors, graph_collectors)

    assert isinstance(chosen_managed, InstagramGraphCollector)
    assert isinstance(chosen_other, InstagramCollector)


def test_managed_flag_without_matching_handle_falls_back_to_web_collector():
    """managed=1 でも Graph 設定が別ハンドル向け (紐付かない) なら web collector のまま。"""
    settings = _settings(with_graph_token=True)
    collectors = build_collectors(settings)
    graph_collectors = build_graph_collectors(settings)

    unrelated_managed_account = {
        "id": 3,
        "platform_id": "instagram",
        "handle": "someone_else_managed",
        "active": 1,
        "managed": 1,
    }
    chosen = select_collector(unrelated_managed_account, collectors, graph_collectors)
    assert isinstance(chosen, InstagramCollector)
