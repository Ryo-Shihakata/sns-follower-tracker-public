"""instagram.py の手段3 (StealthyFetcher) パースの固定フィクスチャテスト。

実 Instagram / 実ブラウザへのアクセスは一切行わない。tests/fixtures/stealth_*.json を
dict として読み込み、parse_stealth_profile() に直接渡す。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from collector.platforms.instagram import parse_stealth_profile

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def test_parses_followers_and_following_from_user_query():
    user_payload = load_fixture("stealth_user_query.json")

    metrics = parse_stealth_profile(user_payload)

    assert metrics.followers == 1234
    assert metrics.following == 10
    assert metrics.posts == 88
    assert metrics.source == "ig-stealth"


def test_no_timeline_payload_means_empty_recent_posts():
    user_payload = load_fixture("stealth_user_query.json")

    metrics = parse_stealth_profile(user_payload)

    assert metrics.recent_posts == []


def test_parses_recent_posts_count_and_order():
    user_payload = load_fixture("stealth_user_query.json")
    timeline_payload = load_fixture("stealth_timeline_connection.json")

    metrics = parse_stealth_profile(user_payload, timeline_payload)

    assert len(metrics.recent_posts) == 3
    assert [p.external_id for p in metrics.recent_posts] == [
        "C8abcDEfgh1",
        "C8videoXyz2",
        "C8sidecar003",
    ]


def test_image_post_fields():
    user_payload = load_fixture("stealth_user_query.json")
    timeline_payload = load_fixture("stealth_timeline_connection.json")
    metrics = parse_stealth_profile(user_payload, timeline_payload)
    post = metrics.recent_posts[0]

    assert post.media_type == "image"
    assert post.url == "https://www.instagram.com/p/C8abcDEfgh1/"
    assert post.posted_at == "2024-07-01T07:00:00Z"
    assert post.likes == 321
    assert post.comments == 12
    assert post.views is None
    assert post.thumbnail_url == "https://scontent.cdninstagram.com/v/thumb1.jpg"
    assert post.caption_full is not None
    assert len(post.caption_head) <= 80


def test_video_post_uses_media_type_2_and_view_count():
    user_payload = load_fixture("stealth_user_query.json")
    timeline_payload = load_fixture("stealth_timeline_connection.json")
    metrics = parse_stealth_profile(user_payload, timeline_payload)
    post = metrics.recent_posts[1]

    assert post.media_type == "video"
    assert post.views == 5400
    assert post.likes == 210
    assert post.comments == 8


def test_carousel_media_type_8_and_hidden_likes_become_none():
    user_payload = load_fixture("stealth_user_query.json")
    timeline_payload = load_fixture("stealth_timeline_connection.json")
    metrics = parse_stealth_profile(user_payload, timeline_payload)
    post = metrics.recent_posts[2]

    assert post.media_type == "carousel"
    assert post.likes is None  # like_and_view_counts_disabled == true -> 非表示扱い
    assert post.caption_head is None  # caption が null


def test_missing_follower_count_raises_keyerror():
    payload = {"data": {"user": {"username": "no_stats"}}}

    with pytest.raises(KeyError):
        parse_stealth_profile(payload)
