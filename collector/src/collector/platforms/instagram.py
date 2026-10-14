"""Instagram collector (docs/implementation-plan.md §5.2)。

取得戦略はフォールバックチェーン (上から順に試す):
  1. 未ログイン Web JSON API (`web_profile_info`) -- 本命。実装済み。
     2026-09 時点、IG がこのエンドポイントへのアクセスを IP 単位で継続的に 429 する
     ようになり、実質的に機能しなくなっている (要観察: 一時的なレート制限か恒久
     ブロックかは未確定)。
  2. 未ログイン HTML 埋め込み -- 実装不可と判明・断念 (2026-09 調査)。現在の IG は
     プロフィール統計をサーバーレンダリング HTML に一切含めない (ld+json も
     `window.__additionalDataLoaded` 相当も存在しない。ログイン有無・`/embed/` の
     いずれのバリアントで見ても `follower` の文字列すら出現しない)。統計はページ
     ロード後にブラウザが自分で GraphQL を叩いて初めて手に入る構造になっており、
     「HTML に埋め込まれた値を拾う」という手段2の前提そのものが成立しない。
  3. ステルスブラウザ (Scrapling StealthyFetcher, patchright ベースの stealth Chrome)
     -- 最終手段。実装済み (2026-09)。`enable_stealth`/`IG_ENABLE_STEALTH` で既定 OFF。
     `pyproject.toml` の `stealth` extra が入っていないと使えない。
     実ブラウザで発行させた GraphQL (`/api/graphql`, `/graphql/query`) レスポンスを
     `capture_xhr` で横取りして読む方式 (手段2が使えない代わりに、手段1と同じ実データ
     取得経路をブラウザの正規リクエストとして代替させる)。**ただし未ログイン状態だと
     プロフィールクエリ自体が `Unauthorized logged out query` で拒否されるため、
     手段4 (`IG_SESSIONID`) が実質的な前提条件**になる (未設定なら試す前に諦める)。
     レスポンスのクエリ種別は URL からは判別できず (`/api/graphql` 自体は汎用エンドポイント)、
     本文の top-level キー (`data.user` か `data.xdt_api__v1__feed__user_timeline_graphql_connection` か)
     でしか見分けられない。
  4. ログインセッション注入 (`IG_SESSIONID`) -- 1/2 のリクエストに Cookie を足すだけの
     後付けオプション。既定 OFF、捨てアカ専用。手段3の実質的な前提でもある (上記参照)。

計画書からの逸脱 (要報告事項):
  計画書 §5.2 は「Scrapling の TLS/JA3 偽装 HTTP クライアント」を本命手段として指定しているが、
  Scrapling の非ブラウザ Fetcher (`scrapling.fetchers.Fetcher`) はモジュール import 時点で
  playwright/patchright に依存しており、`fetchers` extra (playwright, patchright,
  browserforge, apify-fingerprint-datapoints, mcp 等) を丸ごと入れないと動作しない
  ことを確認した (これは実質的にブラウザ関連の重い依存を必須にしてしまい、
  「ブラウザバイナリのインストールを必須にしない」という制約の趣旨に反する)。
  そのため TLS/JA3 偽装 HTTP 部分は Scrapling が内部的に使っている curl_cffi を直接
  利用する形に差し替えた。JA3 偽装という目的自体は curl_cffi の `impersonate=` で
  同等に達成できる。Scrapling 本体は `stealth` extra 経由で手段3 (StealthyFetcher) の
  ためだけに任意インストールできるようにしてある。
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any

from curl_cffi import requests as curl_requests

from collector.models import Metrics, PostMetrics

logger = logging.getLogger(__name__)

WEB_PROFILE_INFO_URL = "https://www.instagram.com/api/v1/users/web_profile_info/"
PROFILE_URL_TEMPLATE = "https://www.instagram.com/{username}/"
IG_APP_ID = "936619743392459"
# IG の Web クライアントが送る既知の固定値 (yt-dlp / instaloader 等、複数の OSS IG
# スクレイパー実装で長期間観測されている定数。ドキュメント化された公式仕様ではないため
# IG 側の変更で無効化される可能性はある)。
X_ASBD_ID = "129477"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)
# curl_cffi の TLS/JA3 指紋偽装プロファイル。Chrome の指紋を模倣する。
# 2026-07 時点でインストール済み curl_cffi (0.15.0) が対応する chrome プロファイルの一覧を
# 確認したところ chrome146 まで対応していたが、あまりに新しいプロファイルは curl_cffi 側の
# 実測・検証がまだ浅い可能性があるため、実運用実績のある少し手前の chrome136 を採用する
# (USER_AGENT の Chrome バージョン表記もこれに合わせてある)。より新しいものに揃えたい場合は
# 両方の値をセットで variable ('chrome142'/'chrome145'/'chrome146' 等) に上げること。
IMPERSONATE_PROFILE = "chrome136"

# 401/429 (bot 疑い・レート制限) 時のみ発動する専用リトライの待機幅。
# main.py 側の全体リトライ (RETRY_BACKOFF_SECONDS=2.0, 全エラー共通) とは別に、
# ここでは bot 検知・レート制限特有の一時的なブロックに対して、実ブラウザの
# 再読み込み間隔に近い長めのランダム待機を1回だけ入れる。
RETRY_STATUS_CODES = frozenset({401, 429})
RETRY_BACKOFF_MIN_SECONDS = 5.0
RETRY_BACKOFF_MAX_SECONDS = 15.0

_MEDIA_TYPE_MAP = {
    "GraphImage": "image",
    "GraphVideo": "video",
    "GraphSidecar": "carousel",
}

# 手段3 (StealthyFetcher) が横取りする GraphQL レスポンスの media_type は、手段1の
# __typename 文字列ではなく IG 内部 API 共通の数値 (1=画像/2=動画/8=カルーセル。
# instagrapi 等の OSS 実装で長期間観測されている値。公式ドキュメントはない)。
_STEALTH_MEDIA_TYPE_MAP = {1: "image", 2: "video", 8: "carousel"}

# StealthyFetcher の capture_xhr 用パターン。IG は `/api/graphql` と `/graphql/query` の
# 両方に同形式の GraphQL レスポンスを流すため、どちらもこの1パターンで拾う
# (クエリ種別は URL では判別できず、レスポンス本体の top-level キーでしか分からない)。
STEALTH_XHR_URL_PATTERN = r"graphql"
STEALTH_WAIT_MS = 3000
STEALTH_TIMEOUT_MS = 30_000
_STEALTH_TIMELINE_KEY = "xdt_api__v1__feed__user_timeline_graphql_connection"


class IGFetchError(Exception):
    """フォールバックチェーンの全手段が失敗したときに送出する。"""


def _build_headers(
    username: str,
    ig_sessionid: str | None = None,
    www_claim: str | None = None,
) -> dict[str, str | None]:
    """web_profile_info 用リクエストヘッダを組み立てる。

    実ブラウザがこのエンドポイントを叩くときの挙動 (プロフィールページ内からの
    同一オリジン fetch/XHR) に近づけるための注意点:

    - curl_cffi の chrome impersonate プロファイルは「トップレベルナビゲーション」を
      前提にしたデフォルトヘッダ (Sec-Fetch-Mode=navigate, Sec-Fetch-User,
      Upgrade-Insecure-Requests, Sec-Ch-Ua-Platform="macOS" 固定など) を自動付与する。
      これは fetch/XHR 呼び出しの実態と矛盾するため、ここで明示的に上書き・削除する。
      値を None にした項目は curl_cffi にヘッダそのものを送らせない指定 (削除)。
    - Referer/Origin は「username のプロフィールページを開いた状態で JS が
      web_profile_info を呼ぶ」という想定に合わせている。
    """
    headers: dict[str, str | None] = {
        "x-ig-app-id": IG_APP_ID,
        "User-Agent": USER_AGENT,
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "*/*",
        "X-Requested-With": "XMLHttpRequest",
        "X-ASBD-ID": X_ASBD_ID,
        # ログイン状態 (sessionid あり) では、直前のレスポンスの
        # `x-ig-set-www-claim` を引き継ぐのが実ブラウザの挙動。未取得時は "0"。
        "X-IG-WWW-Claim": www_claim or "0",
        "Referer": f"https://www.instagram.com/{username}/",
        "Origin": "https://www.instagram.com",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-User": None,
        "Upgrade-Insecure-Requests": None,
        "Sec-Ch-Ua-Platform": '"Windows"',
    }
    if ig_sessionid:
        # 手段4: 後付けオプションのログインセッション注入 (捨てアカ専用・既定 OFF)。
        headers["Cookie"] = f"sessionid={ig_sessionid}"
    return headers


def _extract_likes(node: dict[str, Any]) -> int | None:
    """いいね数を取り出す。非表示設定 (count が欠落 or -1) は None。"""
    like_edge = node.get("edge_liked_by") or node.get("edge_media_preview_like")
    if not like_edge:
        return None
    count = like_edge.get("count")
    if count is None or count < 0:
        return None
    return int(count)


def _extract_caption(node: dict[str, Any]) -> str | None:
    """投稿の全文キャプションを返す。無ければ None。"""
    caption_edges = (node.get("edge_media_to_caption") or {}).get("edges") or []
    if not caption_edges:
        return None
    text = caption_edges[0].get("node", {}).get("text")
    return text or None


def _parse_post_node(node: dict[str, Any]) -> PostMetrics:
    shortcode = node["shortcode"]
    typename = node.get("__typename")
    taken_at = node.get("taken_at_timestamp")
    comments_edge = node.get("edge_media_to_comment") or {}
    comments = comments_edge.get("count")
    caption = _extract_caption(node)
    # サムネイル: thumbnail_src(正方形サムネ)を優先し、無ければ display_url。
    thumbnail = node.get("thumbnail_src") or node.get("display_url")

    return PostMetrics(
        external_id=shortcode,
        url=f"https://www.instagram.com/p/{shortcode}/",
        posted_at=_unix_to_iso8601(taken_at) if taken_at is not None else None,
        media_type=_MEDIA_TYPE_MAP.get(typename, typename),
        caption_head=caption[:80] if caption else None,
        caption_full=caption,
        thumbnail_url=thumbnail,
        likes=_extract_likes(node),
        comments=int(comments) if comments is not None else None,
        views=node.get("video_view_count"),
    )


def _unix_to_iso8601(timestamp: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_web_profile_info(payload: dict[str, Any]) -> Metrics:
    """`web_profile_info` レスポンス (dict) を Metrics に変換する。

    固定フィクスチャによるユニットテストのために curl_cffi 呼び出しから分離してある。
    """
    user = payload["data"]["user"]
    followers = user["edge_followed_by"]["count"]
    following = (user.get("edge_follow") or {}).get("count")
    timeline = user.get("edge_owner_to_timeline_media") or {}
    posts_count = timeline.get("count")
    edges = timeline.get("edges") or []

    recent_posts = [_parse_post_node(edge["node"]) for edge in edges]

    return Metrics(
        followers=followers,
        following=following,
        posts=posts_count,
        recent_posts=recent_posts,
        source="ig-web",
    )


def _read_json_body(captured: Any) -> dict[str, Any] | None:
    """StealthyFetcher が capture_xhr で捕捉した Response の本文を JSON dict として読む。

    捕捉対象には HTML/画像等の非 JSON レスポンスが紛れることは想定していないが
    (capture_xhr は `graphql` パターンでフィルタ済み)、念のため壊れていても
    fetch 全体を落とさず読み飛ばす。
    """
    body = captured.body
    text = body.decode("utf-8", errors="replace") if isinstance(body, (bytes, bytearray)) else body
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def _extract_stealth_thumbnail(node: dict[str, Any]) -> str | None:
    candidates = (node.get("image_versions2") or {}).get("candidates") or []
    return candidates[0].get("url") if candidates else None


def _extract_stealth_likes(node: dict[str, Any]) -> int | None:
    """いいね数を取り出す。非表示設定 (`like_and_view_counts_disabled`) は None。"""
    if node.get("like_and_view_counts_disabled"):
        return None
    likes = node.get("like_count")
    return int(likes) if likes is not None else None


def _parse_stealth_timeline_node(node: dict[str, Any]) -> PostMetrics:
    taken_at = node.get("taken_at")
    caption = (node.get("caption") or {}).get("text")

    return PostMetrics(
        external_id=node["code"],
        url=f"https://www.instagram.com/p/{node['code']}/",
        posted_at=_unix_to_iso8601(taken_at) if taken_at is not None else None,
        media_type=_STEALTH_MEDIA_TYPE_MAP.get(node.get("media_type")),
        caption_head=caption[:80] if caption else None,
        caption_full=caption,
        thumbnail_url=_extract_stealth_thumbnail(node),
        likes=_extract_stealth_likes(node),
        comments=node.get("comment_count"),
        views=node.get("view_count"),
    )


def parse_stealth_profile(
    user_payload: dict[str, Any], timeline_payload: dict[str, Any] | None = None
) -> Metrics:
    """手段3 (StealthyFetcher) が捕捉した GraphQL レスポンスを Metrics に変換する。

    `web_profile_info` (手段1) とはフィールド形が異なる: `edge_followed_by.count` の
    ような入れ子ではなく `follower_count` 等のフラットなキーを使う 2026-09 時点の
    IG 内部 GraphQL の形。`user_payload` はプロフィール統計クエリ (`data.user`)、
    `timeline_payload` は投稿一覧クエリ (`data.xdt_api__v1__feed__user_timeline_graphql_connection`、
    見つからなかった場合は None で recent_posts は空になる)。

    固定フィクスチャによるユニットテストのために StealthyFetcher 呼び出しから分離してある。
    """
    user = user_payload["data"]["user"]
    timeline = ((timeline_payload or {}).get("data") or {}).get(_STEALTH_TIMELINE_KEY) or {}
    edges = timeline.get("edges") or []

    recent_posts = [_parse_stealth_timeline_node(edge["node"]) for edge in edges]

    return Metrics(
        followers=user["follower_count"],
        following=user.get("following_count"),
        posts=user.get("media_count"),
        recent_posts=recent_posts,
        source="ig-stealth",
    )


class InstagramCollector:
    platform_id = "instagram"

    def __init__(self, ig_sessionid: str | None = None, enable_stealth: bool = False) -> None:
        self._ig_sessionid = ig_sessionid
        self._enable_stealth = enable_stealth
        # IG がレスポンスで発行する `x-ig-set-www-claim` を実行間で引き継ぐ
        # (実ブラウザは sessionStorage 相当で保持し、以後のリクエストで echo する)。
        self._www_claim: str | None = None

    async def fetch(self, handle: str) -> Metrics:
        errors: list[str] = []
        try:
            return await self._fetch_via_web_profile_info(handle)
        except Exception as exc:  # noqa: BLE001 - フォールバックチェーンのため意図的に広く捕捉
            logger.warning("web_profile_info failed for %s: %s", handle, exc)
            errors.append(f"web_profile_info: {exc}")

        try:
            return await self._fetch_via_html_embed(handle)
        except NotImplementedError as exc:
            errors.append(f"html_embed: {exc}")
        except Exception as exc:  # noqa: BLE001
            logger.warning("html_embed failed for %s: %s", handle, exc)
            errors.append(f"html_embed: {exc}")

        if self._enable_stealth:
            try:
                return await self._fetch_via_stealth_browser(handle)
            except Exception as exc:  # noqa: BLE001
                logger.warning("stealth_browser failed for %s: %s", handle, exc)
                errors.append(f"stealth_browser: {exc}")

        raise IGFetchError(
            f"all fallback methods failed for @{handle}: " + "; ".join(errors)
        )

    async def _fetch_via_web_profile_info(self, handle: str) -> Metrics:
        """手段1 (本命): 未ログイン Web JSON API を curl_cffi の TLS 偽装で叩く。

        401/429 (bot 疑い・レート制限) を受けた場合のみ、5〜15秒のランダムな
        バックオフを挟んで1回だけ同一リクエストを再試行する。それ以外のエラーは
        そのまま呼び出し元 (fetch() のフォールバックチェーン、さらにその外側の
        main.py の全体リトライ) に委ねる。
        """

        def _do_request() -> curl_requests.Response:
            with curl_requests.Session(impersonate=IMPERSONATE_PROFILE) as session:
                return session.get(
                    WEB_PROFILE_INFO_URL,
                    params={"username": handle},
                    headers=_build_headers(handle, self._ig_sessionid, self._www_claim),
                    timeout=15,
                )

        response = await asyncio.to_thread(_do_request)
        self._capture_www_claim(response)

        if response.status_code in RETRY_STATUS_CODES:
            backoff = random.uniform(RETRY_BACKOFF_MIN_SECONDS, RETRY_BACKOFF_MAX_SECONDS)
            logger.info(
                "web_profile_info returned %d for @%s; backing off %.1fs before one retry",
                response.status_code,
                handle,
                backoff,
            )
            await asyncio.sleep(backoff)
            response = await asyncio.to_thread(_do_request)
            self._capture_www_claim(response)

        response.raise_for_status()
        return parse_web_profile_info(response.json())

    def _capture_www_claim(self, response: curl_requests.Response) -> None:
        claim = response.headers.get("x-ig-set-www-claim")
        if claim:
            self._www_claim = claim

    async def _fetch_via_html_embed(self, handle: str) -> Metrics:
        """手段2: 未ログイン HTML 埋め込みからの抽出 -- 実装断念 (2026-09 調査)。

        当初は `<script type="application/ld+json">` または
        `window.__additionalDataLoaded` 相当の埋め込み JSON をパースする想定だった。
        実際にプロフィール HTML (ログイン有無・`/embed/` の各バリアント) を取得して
        調べたところ、いずれにも `follower` という文字列すら1件も含まれておらず、
        フォロワー数を含む統計情報はサーバーレンダリング HTML に一切埋め込まれて
        いないことを確認した。IG は現在、統計をページロード後にブラウザが自分で
        GraphQL を叩いて初めて取得する構造になっている。つまり「HTML に埋め込まれた
        値を拾う」という手段2の前提そのものが成立しないため、実装せず永続的に
        NotImplementedError を返す (フォールバックチェーンは手段3 に進む)。
        """
        raise NotImplementedError(
            "html embed fallback is not viable: current Instagram profile HTML "
            "(logged-in/out, /embed/ variants) contains no follower/stat data at all "
            "(verified 2026-09); stats are fetched client-side via GraphQL after page load"
        )

    async def _fetch_via_stealth_browser(self, handle: str) -> Metrics:
        """手段3 (最終手段): Scrapling StealthyFetcher (patchright ベースの stealth Chrome)。

        `stealth` extra (pyproject.toml) を入れていない環境では ImportError になる。
        これは意図した挙動 (ブラウザバイナリ導入を必須にしない)。

        実ブラウザにプロフィールページを開かせ、ブラウザが自分で発行する GraphQL
        (`/api/graphql`, `/graphql/query`) レスポンスを `capture_xhr` で横取りして読む
        (手段2が使えない代わりの実データ取得経路)。クエリ種別は URL では判別できないため、
        捕捉した全レスポンスを本文の top-level キーで判別する (`data.user` かつ
        username が一致 = プロフィール統計、`data.{_STEALTH_TIMELINE_KEY}` = 投稿一覧)。

        未ログイン状態だとプロフィール統計クエリ自体が IG 側から
        `Unauthorized logged out query` で拒否される (2026-09 実測で確認済み)。
        そのため `ig_sessionid` (手段4) が実質的な前提条件であり、未設定なら
        ブラウザを起動する前に諦める。
        """
        if not self._ig_sessionid:
            raise IGFetchError(
                "stealth browser fallback requires IG_SESSIONID; logged-out profile "
                "queries are rejected by Instagram (Unauthorized logged out query)"
            )

        try:
            from scrapling.fetchers import StealthyFetcher
        except ImportError as exc:
            raise IGFetchError(
                "stealth browser fetcher is not installed; "
                "run `uv sync --extra stealth` to enable this fallback"
            ) from exc

        def _do_fetch() -> Any:
            return StealthyFetcher.fetch(
                PROFILE_URL_TEMPLATE.format(username=handle),
                headless=True,
                capture_xhr=STEALTH_XHR_URL_PATTERN,
                network_idle=True,
                wait=STEALTH_WAIT_MS,
                timeout=STEALTH_TIMEOUT_MS,
                cookies=[
                    {
                        "name": "sessionid",
                        "value": self._ig_sessionid,
                        "domain": ".instagram.com",
                        "path": "/",
                    }
                ],
            )

        response = await asyncio.to_thread(_do_fetch)

        user_payload: dict[str, Any] | None = None
        timeline_payload: dict[str, Any] | None = None
        for captured in response.captured_xhr:
            payload = _read_json_body(captured)
            if payload is None:
                continue
            data = payload.get("data") or {}
            user = data.get("user")
            if isinstance(user, dict) and str(user.get("username", "")).lower() == handle.lower():
                user_payload = payload
            elif _STEALTH_TIMELINE_KEY in data:
                timeline_payload = payload

        if user_payload is None:
            raise IGFetchError(
                f"stealth browser: no profile data found for @{handle} in captured "
                "GraphQL responses (session may be invalid, or IG changed the response shape)"
            )

        return parse_stealth_profile(user_payload, timeline_payload)
