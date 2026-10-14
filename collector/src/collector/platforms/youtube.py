"""YouTube collector (docs/implementation-plan.md §5.4)。

公式 YouTube Data API v3 の `channels?part=statistics` を叩き、`subscriberCount`
(丸め値) を取得する。`@handle` は `forHandle` パラメータで解決する。
投稿単位の公開指標は Instagram と異なりこの API だけでは取れないため、対象外
(`recent_posts` は常に空)。`YOUTUBE_API_KEY` 未設定なら registry.py 側でこの
collector 自体を組み込まない (計画書の指示通り)。
"""

from __future__ import annotations

from typing import Any

import httpx

from collector.models import Metrics

CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"


class YouTubeFetchError(Exception):
    pass


def parse_channel_statistics(payload: dict[str, Any]) -> Metrics:
    """`channels?part=statistics` レスポンス (dict) を Metrics に変換する。

    固定フィクスチャによるユニットテストのために HTTP 呼び出しから分離してある。
    """
    items = payload.get("items") or []
    if not items:
        raise YouTubeFetchError("channel not found (empty items)")
    statistics = items[0].get("statistics", {})
    subscriber_count = statistics.get("subscriberCount")
    if subscriber_count is None:
        raise YouTubeFetchError("subscriberCount missing (possibly hidden)")
    video_count = statistics.get("videoCount")

    return Metrics(
        followers=int(subscriber_count),
        following=None,
        posts=int(video_count) if video_count is not None else None,
        recent_posts=[],
        source="yt-api",
    )


class YouTubeCollector:
    platform_id = "youtube"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    async def fetch(self, handle: str) -> Metrics:
        params = {"part": "statistics", "key": self._api_key}
        # チャンネルIDらしき文字列 (UC + 22文字) はそのまま id= で、それ以外は forHandle= で解決する。
        if handle.startswith("UC") and len(handle) == 24:
            params["id"] = handle
        else:
            params["forHandle"] = handle if handle.startswith("@") else f"@{handle}"

        async with httpx.AsyncClient(timeout=15.0) as http:
            response = await http.get(CHANNELS_URL, params=params)
            response.raise_for_status()
            payload = response.json()

        return parse_channel_statistics(payload)
