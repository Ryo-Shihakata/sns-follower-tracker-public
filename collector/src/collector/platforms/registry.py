"""platform_id -> Collector インスタンスの組み立て (docs/implementation-plan.md §5.1, §7)。

新しい SNS を追加するときはここに1行足すだけでよい。

Graph API (docs/dashboard-v3-plan.md §4) は「managed アカウントかつトークン設定あり」
のときだけ通常の platform collector を上書きする特別扱いなので、`build_collectors`
(platform 単位) とは別に `build_graph_collectors` (handle 単位) を用意し、
`select_collector` で両者を合成する。
"""

from __future__ import annotations

from collector.config import Settings
from collector.platforms.base import Collector
from collector.platforms.instagram import InstagramCollector
from collector.platforms.instagram_graph import InstagramGraphCollector
from collector.platforms.youtube import YouTubeCollector


def build_collectors(settings: Settings) -> dict[str, Collector]:
    """有効な platform_id -> Collector のマップを返す (通常の web/API collector)。

    YouTube は YOUTUBE_API_KEY 未設定なら含めない (計画書 §5.4)。
    """
    collectors: dict[str, Collector] = {
        "instagram": InstagramCollector(
            ig_sessionid=settings.ig_sessionid,
            enable_stealth=settings.ig_enable_stealth,
        ),
    }
    if settings.youtube_api_key:
        collectors["youtube"] = YouTubeCollector(api_key=settings.youtube_api_key)
    return collectors


def build_graph_collectors(
    settings: Settings,
    token_overrides: dict[str, str] | None = None,
    insights_scope: str = "full",
    audience_flags: dict[str, tuple[bool, bool]] | None = None,
) -> dict[str, Collector]:
    """handle -> Instagram Graph API collector のマップを返す (managed アカウント専用)。

    `settings.ig_graph_accounts` が空 (= IG_GRAPH_TOKEN/IG_GRAPH_USER_ID 未設定) なら
    空の dict を返す。この場合 `select_collector` は常に通常の collector にフォールバックする。

    `token_overrides` は token_refresh.py が返す handle -> 最新トークン (env より新しい
    refresh 済みトークンを使うため)。`insights_scope` は InstagramGraphCollector 参照
    (毎時 run は "recent")。
    `audience_flags` は handle -> (fetch_demographics, fetch_online_followers)。
    main.py が audience_state テーブルの頻度制御 (§2.1: demographics週1回/
    online_followers日1回) を判定した結果で、未指定の handle は両方 False 扱い。
    """
    overrides = token_overrides or {}
    flags = audience_flags or {}
    return {
        handle: InstagramGraphCollector(
            token=overrides.get(handle, cfg["token"]),
            ig_user_id=cfg["ig_user_id"],
            insights_scope=insights_scope,
            fetch_demographics=flags.get(handle, (False, False))[0],
            fetch_online_followers=flags.get(handle, (False, False))[1],
        )
        for handle, cfg in settings.ig_graph_accounts.items()
    }


def select_collector(
    account: dict[str, object],
    collectors: dict[str, Collector],
    graph_collectors: dict[str, Collector],
) -> Collector | None:
    """1アカウントに対して使う Collector を選ぶ (docs/dashboard-v3-plan.md §4.3)。

    `managed=1` かつ該当 handle 向けの Graph collector が組まれていれば優先する。
    それ以外 (managed=0 や、managed=1 でもトークン未設定) は通常の platform collector
    にフォールバックする (= 既存の web collector の挙動を壊さない)。
    """
    handle = account.get("handle")
    if account.get("managed") and isinstance(handle, str) and handle in graph_collectors:
        return graph_collectors[handle]
    platform = account.get("platform_id")
    if not isinstance(platform, str):
        return None
    return collectors.get(platform)
