"""audience_stats (フォロワー属性/online_followers) の頻度制御と payload 組み立てのテスト
(docs/insights-reports-plan.md §2.1)。

実 API / 実ネットワークには触れない。:memory: の LocalStore で
main._should_fetch_audience の判定 (demographics は週1回 / online_followers は1日1回) と、
_metrics_to_snapshot_dict の audience_stats キー省略 (空リストならキー自体を含めない) を検証する。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from collector.main import (
    DEMOGRAPHICS_INTERVAL_DAYS,
    ONLINE_FOLLOWERS_INTERVAL_DAYS,
    _metrics_to_snapshot_dict,
    _should_fetch_audience,
)
from collector.models import Metrics
from collector.store import LocalStore

HANDLE = "example_account"
NOW = datetime(2026, 7, 13, 3, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# -- demographics: 週1回 (前回取得から7日以上) ---------------------------------


def test_demographics_first_run_fetches():
    with LocalStore(":memory:") as store:
        assert _should_fetch_audience(
            store, HANDLE, "demographics", NOW, DEMOGRAPHICS_INTERVAL_DAYS
        )


def test_demographics_right_after_fetch_is_skipped():
    with LocalStore(":memory:") as store:
        store.mark_audience_fetched(HANDLE, "demographics", _iso(NOW))
        assert not _should_fetch_audience(
            store, HANDLE, "demographics", NOW, DEMOGRAPHICS_INTERVAL_DAYS
        )


def test_demographics_after_8_days_fetches_again():
    with LocalStore(":memory:") as store:
        store.mark_audience_fetched(HANDLE, "demographics", _iso(NOW - timedelta(days=8)))
        assert _should_fetch_audience(
            store, HANDLE, "demographics", NOW, DEMOGRAPHICS_INTERVAL_DAYS
        )


def test_demographics_after_6_days_is_still_skipped():
    with LocalStore(":memory:") as store:
        store.mark_audience_fetched(HANDLE, "demographics", _iso(NOW - timedelta(days=6)))
        assert not _should_fetch_audience(
            store, HANDLE, "demographics", NOW, DEMOGRAPHICS_INTERVAL_DAYS
        )


def test_broken_timestamp_falls_back_to_fetch():
    """last_fetched_at が壊れている場合は安全側 (取得する) に倒す。"""
    with LocalStore(":memory:") as store:
        store.mark_audience_fetched(HANDLE, "demographics", "not-a-timestamp")
        assert _should_fetch_audience(
            store, HANDLE, "demographics", NOW, DEMOGRAPHICS_INTERVAL_DAYS
        )


# -- online_followers: 1日1回 --------------------------------------------------


def test_online_followers_first_run_fetches():
    with LocalStore(":memory:") as store:
        assert _should_fetch_audience(
            store, HANDLE, "online_followers", NOW, ONLINE_FOLLOWERS_INTERVAL_DAYS
        )


def test_online_followers_right_after_fetch_is_skipped():
    with LocalStore(":memory:") as store:
        store.mark_audience_fetched(HANDLE, "online_followers", _iso(NOW - timedelta(hours=1)))
        assert not _should_fetch_audience(
            store, HANDLE, "online_followers", NOW, ONLINE_FOLLOWERS_INTERVAL_DAYS
        )


def test_online_followers_next_day_fetches_again():
    with LocalStore(":memory:") as store:
        store.mark_audience_fetched(HANDLE, "online_followers", _iso(NOW - timedelta(days=1)))
        assert _should_fetch_audience(
            store, HANDLE, "online_followers", NOW, ONLINE_FOLLOWERS_INTERVAL_DAYS
        )


# -- _metrics_to_snapshot_dict: audience_stats キーの省略 ----------------------


def test_snapshot_dict_omits_audience_stats_when_empty():
    metrics = Metrics(followers=100, source="ig-graph")
    snap = _metrics_to_snapshot_dict("instagram", HANDLE, _iso(NOW), metrics)

    assert "audience_stats" not in snap


def test_snapshot_dict_includes_audience_stats_when_present():
    stats = [
        {"kind": "demographics_age", "bucket": "18-24", "value": 145},
        {"kind": "online_followers", "bucket": "21", "value": 340},
    ]
    metrics = Metrics(followers=100, source="ig-graph", audience_stats=stats)
    snap = _metrics_to_snapshot_dict("instagram", HANDLE, _iso(NOW), metrics)

    assert snap["audience_stats"] == stats
