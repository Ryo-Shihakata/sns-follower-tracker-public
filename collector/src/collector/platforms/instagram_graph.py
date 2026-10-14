"""Instagram Graph API collector (docs/dashboard-v3-plan.md §4, docs/implementation-plan.md §5.3)。

`accounts.managed=1` のアカウント (当面は example_account のみ) 向けに、Instagram API with
Instagram Login (graph.instagram.com, 2026年新方式) から真の Insights を取得する。
未ログイン Web スクレイピング (`platforms/instagram.py`) とは別経路であり、
`source="ig-graph"` を付与する。

取得の流れ:
  1. `GET /{ig-user-id}?fields=followers_count,media_count`
  2. `GET /{ig-user-id}/media?fields=id,permalink,timestamp,media_type,caption,like_count,comments_count`
  3. 各メディアについて `GET /{media-id}/insights?metric=reach,saved`
     (動画は `views` も追加し、`PostMetrics.views` に入れる。`plays` は 2025年に `views` へ統合済み)
  4. `GET /{ig-user-id}/insights?metric=reach,views&period=day&metric_type=total_value`
     でアカウントレベルの日次 Insights を取得する
     (`impressions`/`profile_views` は Meta が 2025-04-21 に完全廃止、後継は `views`)
  5. (頻度制御あり。§2.1) `GET /{ig-user-id}/insights?metric=follower_demographics
     &period=lifetime&metric_type=total_value&breakdown={age|gender|city}` で週1回
     フォロワー属性を、`GET /{ig-user-id}/insights?metric=online_followers&period=lifetime`
     で1日1回オンライン時間帯を取得する。どちらを取得するかは呼び出し側
     (main.py、audience_state テーブルで頻度管理) がコンストラクタ引数で指定する。

トークン/ID が未設定の場合はこの collector 自体が (registry.py 側の分岐で)
選ばれない。実 Graph API へのアクセスはトークンが無い環境では検証できないため、
パースロジック (`parse_account_and_media` / `parse_media_insights`) は HTTP 呼び出しから
分離し、固定フィクスチャでユニットテストする。

`PostMetrics.external_id` は permalink から抽出した shortcode に正規化する。
スクレイピング経路 (`platforms/instagram.py`) と posts テーブルの UNIQUE
(account_id, external_id) キーを共有し、同一投稿の重複行を防ぐため。
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from collector.models import Metrics, PostMetrics

logger = logging.getLogger(__name__)

GRAPH_API_VERSION = "v25.0"
GRAPH_API_BASE_URL = f"https://graph.instagram.com/{GRAPH_API_VERSION}"

_ACCOUNT_FIELDS = "followers_count,media_count"
_MEDIA_FIELDS = (
    "id,permalink,timestamp,media_type,caption,like_count,comments_count,media_url,thumbnail_url"
)
# メディア別メトリクスセット (docs/insights-reports-plan.md §2.1、§7-1 で実トークン疎通済み)。
# follows/profile_visits はフィード投稿のみ (リールに要求すると API がエラーを返す)。
# 拡張セットが失敗した場合はレガシーセットへフォールバックして収集自体は壊さない。
_IMAGE_INSIGHTS_METRIC_SETS = (
    "reach,saved,follows,profile_visits,shares,total_interactions",
    "reach,saved",
)
_VIDEO_INSIGHTS_METRIC_SETS = (
    "reach,saved,views,shares,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time",
    "reach,saved,views",
)
# アカウントレベルの日次 Insights。reach,views を metric_type=total_value で取得する。
# views (旧 impressions/profile_views の後継) が取得できない環境向けに、失敗時は
# reach のみで再試行して壊れないようにする。
_ACCOUNT_INSIGHTS_METRIC_SETS = (
    "reach,views,accounts_engaged,total_interactions",
    "reach,views",
    "reach",
)

_MEDIA_TYPE_MAP = {
    "IMAGE": "image",
    "VIDEO": "video",
    "CAROUSEL_ALBUM": "carousel",
}


_PERMALINK_SHORTCODE_RE = re.compile(r"instagram\.com/(?:p|reel|tv)/([^/?#]+)")


def _shortcode_from_permalink(permalink: str | None) -> str | None:
    """permalink (`https://www.instagram.com/p/{code}/` 等) から shortcode を抽出する。

    `/p/` `/reel/` `/tv/` 形式に対応。抽出できない場合は None。
    """
    if not permalink:
        return None
    match = _PERMALINK_SHORTCODE_RE.search(permalink)
    return match.group(1) if match else None


class IGGraphFetchError(Exception):
    """Graph API 呼び出し/パースの失敗。"""


def _extract_caption_head(caption: str | None, limit: int = 80) -> str | None:
    if not caption:
        return None
    return caption[:limit]


def parse_media_insights(payload: dict[str, Any]) -> dict[str, int]:
    """`{media-id}/insights` レスポンスを `{metric_name: value}` に変換する。"""
    result: dict[str, int] = {}
    for entry in payload.get("data") or []:
        name = entry.get("name")
        values = entry.get("values") or []
        if not name or not values:
            continue
        value = values[0].get("value")
        if value is not None:
            result[name] = int(value)
    return result


def parse_account_insights(payload: dict[str, Any]) -> dict[str, int]:
    """`{ig-user-id}/insights?period=day` レスポンスを `{metric_name: value}` に変換する。

    `metric_type=total_value` のレスポンスは各エントリが `values:[...]` ではなく
    `total_value:{value:N}` 形式になりうるため、まずそちらを優先して見る。
    旧来の `values:[...]` 形式 (period=day で複数日を含みうるため最新=末尾を採用) にも
    対応し、その値がさらに dict の場合 (total_value 形式が values 内に来るケース) も考慮する。
    """
    result: dict[str, int] = {}
    for entry in payload.get("data") or []:
        name = entry.get("name")
        if not name:
            continue
        value: Any = None
        total_value = entry.get("total_value")
        if isinstance(total_value, dict):
            value = total_value.get("value")
        else:
            values = entry.get("values") or []
            if values:
                value = values[-1].get("value")
                if isinstance(value, dict):
                    value = value.get("value")
        if value is not None:
            result[name] = int(value)
    return result


def parse_follows_and_unfollows(payload: dict[str, Any]) -> tuple[int | None, int | None]:
    """`follows_and_unfollows` (breakdown=follow_type) を (gained, lost) に変換する。

    0件の日は `total_value.breakdowns[].results` 自体が欠落する (§7-1 実測) ため、
    breakdowns 構造が存在するのに results が無い場合は (0, 0) を返す。
    メトリクス自体が返らなかった場合は (None, None)。
    dimension 値の命名ゆれ (FOLLOWER/UNFOLLOW 等) に備え、"UNFOLLOW" を含むかで振り分ける。
    """
    for entry in payload.get("data") or []:
        if entry.get("name") != "follows_and_unfollows":
            continue
        total_value = entry.get("total_value")
        if not isinstance(total_value, dict):
            return (None, None)
        breakdowns = total_value.get("breakdowns") or []
        gained = 0
        lost = 0
        for breakdown in breakdowns:
            for result in breakdown.get("results") or []:
                value = result.get("value")
                if value is None:
                    continue
                dims = result.get("dimension_values") or []
                label = str(dims[0]).upper() if dims else ""
                if "UNFOLLOW" in label:
                    lost += int(value)
                else:
                    gained += int(value)
        return (gained, lost)
    return (None, None)


_DEMOGRAPHICS_BREAKDOWNS = ("age", "gender", "city")
_DEMOGRAPHICS_KIND_MAP = {
    "age": "demographics_age",
    "gender": "demographics_gender",
    "city": "demographics_city",
}


def parse_follower_demographics(payload: dict[str, Any], breakdown: str) -> list[dict[str, Any]]:
    """`follower_demographics` (breakdown=age|gender|city) を `[{kind,bucket,value}]` に変換する。

    `total_value.breakdowns[].results[]` の `dimension_values[0]` が bucket。
    フォロワー100人未満だと取れない (§7-1) ため、`total_value`/`breakdowns`/`results`
    のいずれかが欠落・空の場合は空リストを返す (収集全体は失敗させない)。
    """
    kind = _DEMOGRAPHICS_KIND_MAP.get(breakdown, f"demographics_{breakdown}")
    for entry in payload.get("data") or []:
        if entry.get("name") != "follower_demographics":
            continue
        total_value = entry.get("total_value")
        if not isinstance(total_value, dict):
            return []
        results: list[dict[str, Any]] = []
        for bd in total_value.get("breakdowns") or []:
            for result in bd.get("results") or []:
                value = result.get("value")
                dims = result.get("dimension_values") or []
                if value is None or not dims:
                    continue
                results.append({"kind": kind, "bucket": str(dims[0]), "value": int(value)})
        return results
    return []


def parse_online_followers(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """`online_followers` (period=lifetime) を `[{kind:"online_followers",bucket,value}]` に変換する。

    `values[]` の最新 (末尾) エントリの `value` (時間帯"0"〜"23" -> 人数 の dict) を使う。
    §7-1 の実測で `values` が空 `{}` のことがあるため、その場合や `values` 自体が
    欠落している場合は空リストを返す (空なら送らない)。
    """
    for entry in payload.get("data") or []:
        if entry.get("name") != "online_followers":
            continue
        values = entry.get("values") or []
        if not values:
            return []
        latest = values[-1].get("value")
        if not isinstance(latest, dict) or not latest:
            return []
        return [
            {"kind": "online_followers", "bucket": str(hour), "value": int(count)}
            for hour, count in latest.items()
        ]
    return []


def _parse_media_node(node: dict[str, Any], insights: dict[str, int]) -> PostMetrics:
    media_type = node.get("media_type")
    like_count = node.get("like_count")
    comments_count = node.get("comments_count")
    caption = node.get("caption")
    # 動画はポスター画像(thumbnail_url)、画像/カルーセルは media_url をサムネイルに使う。
    thumbnail = node.get("thumbnail_url") or node.get("media_url")
    # external_id は scraping 経路と posts テーブルの UNIQUE キーを共有するため
    # shortcode に正規化する。permalink 欠損/形式不明時のみ数値 media id にフォールバック。
    external_id = _shortcode_from_permalink(node.get("permalink")) or node["id"]

    return PostMetrics(
        external_id=external_id,
        url=node.get("permalink"),
        posted_at=node.get("timestamp"),
        media_type=_MEDIA_TYPE_MAP.get(media_type, media_type.lower() if media_type else None),
        caption_head=_extract_caption_head(caption),
        caption_full=caption or None,
        thumbnail_url=thumbnail,
        likes=int(like_count) if like_count is not None else None,
        comments=int(comments_count) if comments_count is not None else None,
        views=insights.get("views"),
        reach=insights.get("reach"),
        saved=insights.get("saved"),
        follows=insights.get("follows"),
        profile_visits=insights.get("profile_visits"),
        shares=insights.get("shares"),
        total_interactions=insights.get("total_interactions"),
        avg_watch_time_ms=insights.get("ig_reels_avg_watch_time"),
        total_watch_time_ms=insights.get("ig_reels_video_view_total_time"),
    )


def parse_account_and_media(
    account_payload: dict[str, Any],
    media_payload: dict[str, Any],
    insights_by_media_id: dict[str, dict[str, int]],
    account_insights: dict[str, int] | None = None,
    follows_and_unfollows: tuple[int | None, int | None] = (None, None),
    audience_stats: list[dict[str, Any]] | None = None,
) -> Metrics:
    """アカウント情報 + メディア一覧 + メディアごとの insights を Metrics に変換する。

    固定フィクスチャによるユニットテストのために HTTP 呼び出しから分離してある。
    `account_insights` はアカウントレベルの日次 Insights
    ({reach,views,accounts_engaged,total_interactions})。
    `follows_and_unfollows` は (gained, lost)。
    `audience_stats` はフォロワー属性/online_followers (§2.1、取得タイミングでない
    run では None/空リストのまま)。
    """
    followers = account_payload["followers_count"]
    media_count = account_payload.get("media_count")
    acc = account_insights or {}
    gained, lost = follows_and_unfollows

    nodes = media_payload.get("data") or []
    recent_posts = [
        _parse_media_node(node, insights_by_media_id.get(node["id"], {})) for node in nodes
    ]

    return Metrics(
        followers=int(followers),
        following=None,
        posts=int(media_count) if media_count is not None else None,
        recent_posts=recent_posts,
        source="ig-graph",
        account_reach=acc.get("reach"),
        account_views=acc.get("views"),
        account_follows_gained=gained,
        account_follows_lost=lost,
        account_accounts_engaged=acc.get("accounts_engaged"),
        account_total_interactions=acc.get("total_interactions"),
        audience_stats=audience_stats or [],
    )


def _is_insights_target(
    node: dict[str, Any], index: int, recent_limit: int, recent_days: int, now: datetime
) -> bool:
    """insights_scope="recent" のとき insights を取得すべきメディアか判定する。

    「新しい順で先頭 recent_limit 件」または「posted_at が recent_days 日以内」が対象。
    timestamp が読めないノードは安全側 (対象) に倒す。
    """
    if index < recent_limit:
        return True
    raw = node.get("timestamp")
    if not raw:
        return True
    try:
        posted = datetime.strptime(str(raw), "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        return True
    return (now - posted).days < recent_days


class InstagramGraphCollector:
    """管理アカウント1件 (token + ig_user_id で紐付け) 分の Graph API collector。

    `insights_scope`:
      - "full"   (既定): 取得した全メディアの insights を取る (1日3回の通常run)
      - "recent": 新しい順 12 件 + 7日以内の投稿だけ insights を取る (毎時run、
                  docs/insights-reports-plan.md §2.2。古い投稿の insights はほぼ動かず
                  API 呼び出しを浪費するため)

    `fetch_demographics`/`fetch_online_followers` は §2.1 の頻度制御 (demographics は
    週1回、online_followers は1日1回) の結果を呼び出し側 (main.py、audience_state
    テーブルで判定) が渡すフラグ。この collector 自体は頻度を判断しない。
    """

    platform_id = "instagram"

    RECENT_LIMIT = 12
    RECENT_DAYS = 7

    def __init__(
        self,
        token: str,
        ig_user_id: str,
        insights_scope: str = "full",
        fetch_demographics: bool = False,
        fetch_online_followers: bool = False,
    ) -> None:
        self._token = token
        self._ig_user_id = ig_user_id
        self._insights_scope = insights_scope
        self._collect_demographics = fetch_demographics
        self._collect_online_followers = fetch_online_followers

    async def fetch(self, handle: str) -> Metrics:
        # handle は registry.py の紐付け確認用の情報でしかなく、Graph API 呼び出し自体は
        # コンストラクタで受け取った ig_user_id で行う (Graph API は handle を知らない)。
        now = datetime.now(timezone.utc)
        async with httpx.AsyncClient(timeout=15.0) as http:
            account_payload = await self._get(http, self._ig_user_id, {"fields": _ACCOUNT_FIELDS})
            media_payload = await self._get(
                http, f"{self._ig_user_id}/media", {"fields": _MEDIA_FIELDS}
            )

            insights_by_media_id: dict[str, dict[str, int]] = {}
            for index, node in enumerate(media_payload.get("data") or []):
                media_id = node["id"]
                if self._insights_scope == "recent" and not _is_insights_target(
                    node, index, self.RECENT_LIMIT, self.RECENT_DAYS, now
                ):
                    insights_by_media_id[media_id] = {}
                    continue
                metric_sets = (
                    _VIDEO_INSIGHTS_METRIC_SETS
                    if node.get("media_type") == "VIDEO"
                    else _IMAGE_INSIGHTS_METRIC_SETS
                )
                insights_by_media_id[media_id] = await self._fetch_media_insights(
                    http, media_id, metric_sets
                )

            account_insights = await self._fetch_account_insights(http)
            follows_and_unfollows = await self._fetch_follows_and_unfollows(http)

            audience_stats: list[dict[str, Any]] = []
            if self._collect_demographics:
                audience_stats.extend(await self._fetch_follower_demographics(http))
            if self._collect_online_followers:
                audience_stats.extend(await self._fetch_online_followers(http))

        return parse_account_and_media(
            account_payload,
            media_payload,
            insights_by_media_id,
            account_insights,
            follows_and_unfollows,
            audience_stats,
        )

    async def _fetch_media_insights(
        self, http: httpx.AsyncClient, media_id: str, metric_sets: tuple[str, ...]
    ) -> dict[str, int]:
        """メディア insights を拡張セット→レガシーセットの順で防御的に取得する。

        全セット失敗しても投稿全体は失敗にしない (空 dict を返す)。
        """
        for metric in metric_sets:
            try:
                payload = await self._get(http, f"{media_id}/insights", {"metric": metric})
                return parse_media_insights(payload)
            except Exception as exc:  # noqa: BLE001 - insights欠損は投稿全体を失敗にしない
                logger.warning(
                    "insights fetch failed for media=%s (metric=%s): %s", media_id, metric, exc
                )
        return {}

    async def _fetch_account_insights(self, http: httpx.AsyncClient) -> dict[str, int]:
        """アカウントレベルの日次 Insights を防御的に取得する。

        `reach,views` を `metric_type=total_value` で取得する。views (旧
        impressions/profile_views の後継、Meta 2025-04-21 廃止) がバージョン/アカウントにより
        取得不可のことがあるため、失敗時は reach のみで再試行し、成功した最初のレスポンスを
        パースして返す。全滅時は空 (= account_reach/account_views は None のまま。収集全体は
        失敗させない)。
        """
        for metric in _ACCOUNT_INSIGHTS_METRIC_SETS:
            try:
                payload = await self._get(
                    http,
                    f"{self._ig_user_id}/insights",
                    {"metric": metric, "period": "day", "metric_type": "total_value"},
                )
                return parse_account_insights(payload)
            except Exception as exc:  # noqa: BLE001 - insights欠損はアカウント取得全体を失敗にしない
                logger.warning(
                    "account insights fetch failed (metric=%s): %s", metric, exc
                )
        return {}

    async def _fetch_follows_and_unfollows(
        self, http: httpx.AsyncClient
    ) -> tuple[int | None, int | None]:
        """`follows_and_unfollows` (breakdown=follow_type) を防御的に取得する。

        取得失敗しても収集全体は失敗にしない ((None, None) を返す)。
        """
        try:
            payload = await self._get(
                http,
                f"{self._ig_user_id}/insights",
                {
                    "metric": "follows_and_unfollows",
                    "period": "day",
                    "metric_type": "total_value",
                    "breakdown": "follow_type",
                },
            )
            return parse_follows_and_unfollows(payload)
        except Exception as exc:  # noqa: BLE001 - insights欠損はアカウント取得全体を失敗にしない
            logger.warning("follows_and_unfollows fetch failed: %s", exc)
            return (None, None)

    async def _fetch_follower_demographics(self, http: httpx.AsyncClient) -> list[dict[str, Any]]:
        """週1回想定の `follower_demographics` を age/gender/city の3breakdownで防御的に取得する。

        フォロワー100人未満だと取れないことがある (§7-1)。1breakdownの失敗は他の
        breakdownやアカウント取得全体に影響させず、そのbreakdown分だけ空のまま続行する。
        """
        result: list[dict[str, Any]] = []
        for breakdown in _DEMOGRAPHICS_BREAKDOWNS:
            try:
                payload = await self._get(
                    http,
                    f"{self._ig_user_id}/insights",
                    {
                        "metric": "follower_demographics",
                        "period": "lifetime",
                        "metric_type": "total_value",
                        "breakdown": breakdown,
                    },
                )
                result.extend(parse_follower_demographics(payload, breakdown))
            except Exception as exc:  # noqa: BLE001 - 属性欠損は収集全体を失敗にしない
                logger.warning(
                    "follower_demographics fetch failed (breakdown=%s): %s", breakdown, exc
                )
        return result

    async def _fetch_online_followers(self, http: httpx.AsyncClient) -> list[dict[str, Any]]:
        """1日1回想定の `online_followers` を防御的に取得する。

        §7-1 の実測で値が空 `{}` のことがあるため、その場合も空リストのまま続行する
        (収集全体は失敗させない)。
        """
        try:
            payload = await self._get(
                http,
                f"{self._ig_user_id}/insights",
                {"metric": "online_followers", "period": "lifetime"},
            )
            return parse_online_followers(payload)
        except Exception as exc:  # noqa: BLE001 - insights欠損は収集全体を失敗にしない
            logger.warning("online_followers fetch failed: %s", exc)
            return []

    async def _get(
        self, http: httpx.AsyncClient, path: str, params: dict[str, str]
    ) -> dict[str, Any]:
        query = dict(params)
        query["access_token"] = self._token
        response = await http.get(f"{GRAPH_API_BASE_URL}/{path}", params=query)
        response.raise_for_status()
        return response.json()
