"""instagram.py の web_profile_info パースの固定フィクスチャテスト。

実 Instagram へのアクセスは一切行わない。tests/fixtures/*.json を dict として読み込み、
parse_web_profile_info() に直接渡す。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from collector.platforms.instagram import parse_web_profile_info

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def test_parses_followers_and_following():
    payload = load_fixture("web_profile_info_sample.json")
    metrics = parse_web_profile_info(payload)

    assert metrics.followers == 1234
    assert metrics.following == 10
    assert metrics.posts == 88
    assert metrics.source == "ig-web"


def test_parses_recent_posts_count_and_order():
    payload = load_fixture("web_profile_info_sample.json")
    metrics = parse_web_profile_info(payload)

    assert len(metrics.recent_posts) == 3
    assert [p.external_id for p in metrics.recent_posts] == [
        "C8abcDEfgh1",
        "C8videoXyz2",
        "C8sidecar003",
    ]


def test_image_post_fields():
    payload = load_fixture("web_profile_info_sample.json")
    metrics = parse_web_profile_info(payload)
    post = metrics.recent_posts[0]

    assert post.media_type == "image"
    assert post.url == "https://www.instagram.com/p/C8abcDEfgh1/"
    assert post.posted_at == "2024-07-01T07:00:00Z"
    assert post.likes == 321
    assert post.comments == 12
    assert post.views is None
    assert post.caption_head is not None
    assert len(post.caption_head) <= 80
    # v4: サムネイル(thumbnail_src 優先)と全文キャプションも取得する
    assert post.thumbnail_url == "https://scontent.cdninstagram.com/v/thumb1.jpg"
    assert post.caption_full is not None
    assert len(post.caption_full) > 80  # 全文は80字を超える


def test_video_post_uses_view_count_and_preview_like():
    payload = load_fixture("web_profile_info_sample.json")
    metrics = parse_web_profile_info(payload)
    post = metrics.recent_posts[1]

    assert post.media_type == "video"
    assert post.views == 5400
    assert post.likes == 210  # edge_media_preview_like フォールバック
    assert post.comments == 8


def test_hidden_likes_become_none():
    payload = load_fixture("web_profile_info_sample.json")
    metrics = parse_web_profile_info(payload)
    post = metrics.recent_posts[2]

    assert post.media_type == "carousel"
    assert post.likes is None  # edge_liked_by.count == -1 -> 非表示扱い
    assert post.caption_head is None  # caption edges が空


def test_no_posts_and_missing_following():
    payload = load_fixture("web_profile_info_no_posts.json")
    metrics = parse_web_profile_info(payload)

    assert metrics.followers == 42
    assert metrics.following is None
    assert metrics.recent_posts == []


def test_caption_is_truncated_to_80_chars():
    payload = load_fixture("web_profile_info_sample.json")
    metrics = parse_web_profile_info(payload)
    post = metrics.recent_posts[0]

    full_caption = (
        payload["data"]["user"]["edge_owner_to_timeline_media"]["edges"][0]["node"]
        ["edge_media_to_caption"]["edges"][0]["node"]["text"]
    )
    assert len(full_caption) > 80
    assert post.caption_head == full_caption[:80]
