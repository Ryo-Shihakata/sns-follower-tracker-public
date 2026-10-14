"""instagram_graph.py のパースの固定フィクスチャテスト (docs/dashboard-v3-plan.md §4)。

実 Graph API へのアクセスは一切行わない。tests/fixtures/ig_graph_*.json を dict として
読み込み、parse_account_and_media() / parse_media_insights() に直接渡す。
"""

from __future__ import annotations

import json
from pathlib import Path

from collector.platforms.instagram_graph import (
    parse_account_and_media,
    parse_account_insights,
    parse_follower_demographics,
    parse_follows_and_unfollows,
    parse_media_insights,
    parse_online_followers,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def test_parse_media_insights_extracts_metric_values():
    payload = load_fixture("ig_graph_insights_image.json")
    insights = parse_media_insights(payload)

    assert insights == {"reach": 1200, "saved": 34}


def test_parse_media_insights_includes_views_for_video():
    payload = load_fixture("ig_graph_insights_video.json")
    insights = parse_media_insights(payload)

    assert insights == {"reach": 5400, "saved": 60, "views": 9800}


def _build_metrics():
    account_payload = load_fixture("ig_graph_account.json")
    media_payload = load_fixture("ig_graph_media.json")
    insights_by_media_id = {
        "18000000000000001": parse_media_insights(load_fixture("ig_graph_insights_image.json")),
        "18000000000000002": parse_media_insights(load_fixture("ig_graph_insights_video.json")),
        # carousel は insights 取得が失敗した想定 (空のまま)
    }
    return parse_account_and_media(account_payload, media_payload, insights_by_media_id)


def test_parses_followers_and_media_count():
    metrics = _build_metrics()

    assert metrics.followers == 5000
    assert metrics.posts == 42
    assert metrics.following is None
    assert metrics.source == "ig-graph"
    assert len(metrics.recent_posts) == 4


def test_image_post_includes_reach_and_saved():
    metrics = _build_metrics()
    post = metrics.recent_posts[0]

    # external_id は permalink (/p/ 形式) から抽出した shortcode に正規化される
    assert post.external_id == "GRAPHIMAGE1"
    assert post.media_type == "image"
    assert post.url == "https://www.instagram.com/p/GRAPHIMAGE1/"
    assert post.likes == 321
    assert post.comments == 12
    assert post.views is None  # 画像は plays が無い
    assert post.reach == 1200
    assert post.saved == 34
    assert post.caption_head is not None and len(post.caption_head) <= 80
    # v4: 画像は media_url をサムネイル、caption_full に全文
    assert post.thumbnail_url == "https://scontent.cdninstagram.com/graph/image1.jpg"
    assert post.caption_full == "体育祭の様子をお届けします。今年は天候にも恵まれて盛り上がりました。"


def test_video_post_includes_views():
    metrics = _build_metrics()
    post = metrics.recent_posts[1]

    # external_id は /reel/ 形式の permalink からも shortcode を抽出できる
    assert post.external_id == "GRAPHVIDEO2"
    assert post.url == "https://www.instagram.com/reel/GRAPHVIDEO2/"
    assert post.media_type == "video"
    assert post.likes == 210
    assert post.views == 9800  # plays は views に統合済み (2025年)
    assert post.reach == 5400
    assert post.saved == 60
    # v4: 動画は thumbnail_url をポスター画像に使う
    assert post.thumbnail_url == "https://scontent.cdninstagram.com/graph/video2_thumb.jpg"


def test_carousel_post_missing_insights_leaves_fields_none():
    metrics = _build_metrics()
    post = metrics.recent_posts[2]

    assert post.external_id == "GRAPHCAROUSEL3"
    assert post.media_type == "carousel"
    assert post.caption_head is None
    assert post.reach is None
    assert post.saved is None
    assert post.views is None


def test_missing_permalink_falls_back_to_media_id():
    """permalink が欠損している node は external_id を数値 media id にフォールバックする。"""
    metrics = _build_metrics()
    post = metrics.recent_posts[3]

    assert post.external_id == "18000000000000004"
    assert post.url is None


def test_parse_account_insights_handles_total_value_form():
    payload = load_fixture("ig_graph_account_insights.json")
    insights = parse_account_insights(payload)

    # metric_type=total_value 形式: 各エントリの total_value.value を採用する
    assert insights == {"reach": 3200, "views": 9100}


def test_parse_account_insights_takes_latest_day_value_legacy_values_form():
    # 旧来の values:[...] (period=day, 複数日) 形式にも対応できること。最新(末尾)を採用する。
    payload = {
        "data": [
            {
                "name": "reach",
                "values": [{"value": 3000}, {"value": 3200}],
            }
        ]
    }
    assert parse_account_insights(payload) == {"reach": 3200}


def test_parse_account_insights_handles_total_value_dict_form():
    # values 内の value がさらに dict (total_value 形式) でも取り出せること
    payload = {"data": [{"name": "reach", "values": [{"value": {"value": 4200}}]}]}
    assert parse_account_insights(payload) == {"reach": 4200}


def test_account_insights_flow_into_metrics():
    account_payload = load_fixture("ig_graph_account.json")
    media_payload = load_fixture("ig_graph_media.json")
    account_insights = parse_account_insights(load_fixture("ig_graph_account_insights.json"))
    metrics = parse_account_and_media(account_payload, media_payload, {}, account_insights)

    assert metrics.account_reach == 3200
    assert metrics.account_views == 9100


def test_account_insights_default_none_when_absent():
    """account_insights を渡さない (web collector 相当) と両フィールドは None。"""
    account_payload = load_fixture("ig_graph_account.json")
    media_payload = load_fixture("ig_graph_media.json")
    metrics = parse_account_and_media(account_payload, media_payload, {})

    assert metrics.account_reach is None
    assert metrics.account_views is None


# -- insights-reports-plan §2.1 追加メトリクス --------------------------------


def test_parse_media_insights_extracts_expanded_feed_metrics():
    """フィード投稿の拡張セット (follows/profile_visits/shares/total_interactions)。"""
    payload = {
        "data": [
            {"name": "reach", "values": [{"value": 1200}]},
            {"name": "saved", "values": [{"value": 34}]},
            {"name": "follows", "values": [{"value": 4}]},
            {"name": "profile_visits", "values": [{"value": 209}]},
            {"name": "shares", "values": [{"value": 1}]},
            {"name": "total_interactions", "values": [{"value": 166}]},
        ]
    }
    insights = parse_media_insights(payload)
    assert insights["follows"] == 4
    assert insights["profile_visits"] == 209
    assert insights["shares"] == 1
    assert insights["total_interactions"] == 166


def test_media_node_maps_expanded_metrics_to_post_fields():
    account_payload = load_fixture("ig_graph_account.json")
    media_payload = load_fixture("ig_graph_media.json")
    insights_by_media_id = {
        "18000000000000001": {
            "reach": 1200,
            "saved": 34,
            "follows": 4,
            "profile_visits": 209,
            "shares": 1,
            "total_interactions": 166,
        },
        "18000000000000002": {
            "reach": 5400,
            "saved": 60,
            "views": 9800,
            "shares": 18,
            "total_interactions": 576,
            "ig_reels_avg_watch_time": 20467,
            "ig_reels_video_view_total_time": 279838428,
        },
    }
    metrics = parse_account_and_media(account_payload, media_payload, insights_by_media_id)

    feed = metrics.recent_posts[0]
    assert feed.follows == 4
    assert feed.profile_visits == 209
    assert feed.shares == 1
    assert feed.total_interactions == 166
    assert feed.avg_watch_time_ms is None

    reel = metrics.recent_posts[1]
    assert reel.follows is None  # リールは follows 非対応 (§7-1)
    assert reel.shares == 18
    assert reel.avg_watch_time_ms == 20467
    assert reel.total_watch_time_ms == 279838428


def test_parse_account_insights_includes_engagement_metrics():
    payload = {
        "data": [
            {"name": "reach", "total_value": {"value": 3200}},
            {"name": "views", "total_value": {"value": 9100}},
            {"name": "accounts_engaged", "total_value": {"value": 198}},
            {"name": "total_interactions", "total_value": {"value": 289}},
        ]
    }
    insights = parse_account_insights(payload)
    assert insights["accounts_engaged"] == 198
    assert insights["total_interactions"] == 289


def test_parse_follows_and_unfollows_with_results():
    payload = {
        "data": [
            {
                "name": "follows_and_unfollows",
                "total_value": {
                    "breakdowns": [
                        {
                            "dimension_keys": ["follow_type"],
                            "results": [
                                {"dimension_values": ["FOLLOWER"], "value": 5},
                                {"dimension_values": ["UNFOLLOWER"], "value": 2},
                            ],
                        }
                    ]
                },
            }
        ]
    }
    assert parse_follows_and_unfollows(payload) == (5, 2)


def test_parse_follows_and_unfollows_zero_day_missing_results():
    """0件の日は breakdowns[].results が欠落する (§7-1 実測) -> (0, 0)。"""
    payload = {
        "data": [
            {
                "name": "follows_and_unfollows",
                "total_value": {"breakdowns": [{"dimension_keys": ["follow_type"]}]},
            }
        ]
    }
    assert parse_follows_and_unfollows(payload) == (0, 0)


def test_parse_follows_and_unfollows_metric_absent():
    assert parse_follows_and_unfollows({"data": []}) == (None, None)


def test_account_metrics_carry_follows_and_engagement():
    account_payload = load_fixture("ig_graph_account.json")
    media_payload = load_fixture("ig_graph_media.json")
    metrics = parse_account_and_media(
        account_payload,
        media_payload,
        {},
        account_insights={"reach": 3200, "accounts_engaged": 198, "total_interactions": 289},
        follows_and_unfollows=(5, 2),
    )
    assert metrics.account_follows_gained == 5
    assert metrics.account_follows_lost == 2
    assert metrics.account_accounts_engaged == 198
    assert metrics.account_total_interactions == 289


# -- insights-reports-plan §2.1 follower_demographics / online_followers -----


def test_parse_follower_demographics_extracts_age_buckets():
    payload = load_fixture("ig_graph_demographics_age.json")
    result = parse_follower_demographics(payload, "age")

    assert result == [
        {"kind": "demographics_age", "bucket": "13-17", "value": 12},
        {"kind": "demographics_age", "bucket": "18-24", "value": 145},
        {"kind": "demographics_age", "bucket": "25-34", "value": 33},
    ]


def test_parse_follower_demographics_uses_kind_for_breakdown():
    payload = load_fixture("ig_graph_demographics_age.json")
    # breakdown 引数どおりの kind が付与されること (gender/city も同じ構造で呼ばれる想定)
    result = parse_follower_demographics(payload, "gender")

    assert all(item["kind"] == "demographics_gender" for item in result)


def test_parse_follower_demographics_zero_results_returns_empty_list():
    """breakdowns はあるが results が無い (0件、follows_and_unfollows と同様のケース)。"""
    payload = {
        "data": [
            {
                "name": "follower_demographics",
                "total_value": {"breakdowns": [{"dimension_keys": ["age"]}]},
            }
        ]
    }
    assert parse_follower_demographics(payload, "age") == []


def test_parse_follower_demographics_metric_absent_returns_empty_list():
    """フォロワー100人未満などでメトリクス自体が返らない場合 (§7-1)。"""
    assert parse_follower_demographics({"data": []}, "age") == []


def test_parse_online_followers_extracts_latest_hourly_buckets():
    payload = load_fixture("ig_graph_online_followers.json")
    result = parse_online_followers(payload)

    assert {"kind": "online_followers", "bucket": "0", "value": 12} in result
    assert {"kind": "online_followers", "bucket": "21", "value": 340} in result
    assert len(result) == 4


def test_parse_online_followers_empty_value_dict_returns_empty_list():
    """§7-1 実測: values はあるが value が空 `{}` のことがある -> 空なら送らない。"""
    payload = {"data": [{"name": "online_followers", "values": [{"value": {}}]}]}
    assert parse_online_followers(payload) == []


def test_parse_online_followers_values_missing_returns_empty_list():
    payload = {"data": [{"name": "online_followers", "values": []}]}
    assert parse_online_followers(payload) == []


def test_parse_online_followers_metric_absent_returns_empty_list():
    assert parse_online_followers({"data": []}) == []


def test_account_and_media_carries_audience_stats():
    account_payload = load_fixture("ig_graph_account.json")
    media_payload = load_fixture("ig_graph_media.json")
    audience_stats = [
        {"kind": "demographics_age", "bucket": "18-24", "value": 145},
        {"kind": "online_followers", "bucket": "21", "value": 340},
    ]
    metrics = parse_account_and_media(
        account_payload, media_payload, {}, audience_stats=audience_stats
    )

    assert metrics.audience_stats == audience_stats


def test_account_and_media_default_audience_stats_is_empty_list():
    account_payload = load_fixture("ig_graph_account.json")
    media_payload = load_fixture("ig_graph_media.json")
    metrics = parse_account_and_media(account_payload, media_payload, {})

    assert metrics.audience_stats == []
