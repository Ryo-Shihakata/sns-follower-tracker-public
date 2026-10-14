"""youtube.py の channels?part=statistics レスポンスパースのテスト (固定フィクスチャ相当)。"""

from __future__ import annotations

import pytest

from collector.platforms.youtube import YouTubeFetchError, parse_channel_statistics


def test_parses_subscriber_and_video_count():
    payload = {
        "items": [
            {
                "id": "UCabcdefghijklmnopqrstu",
                "statistics": {
                    "viewCount": "999999",
                    "subscriberCount": "4321",
                    "hiddenSubscriberCount": False,
                    "videoCount": "88",
                },
            }
        ]
    }
    metrics = parse_channel_statistics(payload)

    assert metrics.followers == 4321
    assert metrics.posts == 88
    assert metrics.following is None
    assert metrics.recent_posts == []
    assert metrics.source == "yt-api"


def test_empty_items_raises():
    with pytest.raises(YouTubeFetchError):
        parse_channel_statistics({"items": []})


def test_hidden_subscriber_count_raises():
    payload = {"items": [{"id": "UCxyz", "statistics": {"hiddenSubscriberCount": True, "videoCount": "3"}}]}
    with pytest.raises(YouTubeFetchError):
        parse_channel_statistics(payload)
