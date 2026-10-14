"""Instagram Login API 長期トークンの自動 refresh (docs/insights-reports-plan.md §2.4)。

長期トークンは発行から60日で失効する。`GET /refresh_access_token?grant_type=ig_refresh_token`
(client_secret 不要) で新しい60日トークンに更新できるため、前回 refresh から
`REFRESH_INTERVAL_DAYS` 日以上経っていれば毎 run の冒頭で更新を試みる。

状態は LocalStore の token_state テーブルに持つ:
  - seed_token:    .env 由来のトークン。.env が書き換えられた (ユーザーがダッシュボードで
                   再発行して貼り直した) ことを検知するための比較用
  - current_token: 実際に使う最新トークン (refresh 成功のたびに更新)
  - refreshed_at / expires_at: 最終 refresh 時刻と有効期限 (ISO8601 UTC)

.env の値が seed_token と異なる場合は「ユーザーが新トークンを設定した」とみなし、
状態を .env の値でリセットする (= 常にユーザー設定が勝つ)。

refresh 失敗は警告ログのみで run は続行する (発行24時間未満のトークンは refresh
できない IG 仕様があるため、失敗は必ずしも異常ではない。トークンが本当に失効した
場合は収集自体が code 190 で失敗し、既存の collect_fail イベントで可視化される)。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import httpx

from collector.store import LocalStore

logger = logging.getLogger(__name__)

REFRESH_INTERVAL_DAYS = 7

# refresh_access_token はバージョンプレフィックスなしが正式 (Instagram Login API)。
REFRESH_ENDPOINT = "https://graph.instagram.com/refresh_access_token"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


async def refresh_graph_tokens(
    graph_accounts: dict[str, dict[str, str]],
    store: LocalStore,
    http: httpx.AsyncClient | None = None,
) -> dict[str, str]:
    """handle -> 有効トークン のマップを返す。必要なら refresh して token_state を更新する。

    `graph_accounts` は Settings.ig_graph_accounts (handle -> {token, ig_user_id})。
    返り値のトークンで Graph collector を組むこと (env の値より新しい場合がある)。
    """
    result: dict[str, str] = {}
    own_client = http is None
    client = http or httpx.AsyncClient(timeout=15.0)
    try:
        for handle, cfg in graph_accounts.items():
            env_token = cfg["token"]
            state = store.get_token_state(handle)

            if state is None or state["seed_token"] != env_token:
                # 初見 or ユーザーが .env を差し替えた -> env の値でリセット
                store.save_token_state(handle, env_token, env_token, None, None)
                state = store.get_token_state(handle)
            assert state is not None

            current = state["current_token"]
            refreshed_at = state["refreshed_at"]
            needs_refresh = True
            if refreshed_at:
                try:
                    last = datetime.strptime(refreshed_at, "%Y-%m-%dT%H:%M:%SZ").replace(
                        tzinfo=timezone.utc
                    )
                    needs_refresh = _now() - last >= timedelta(days=REFRESH_INTERVAL_DAYS)
                except ValueError:
                    pass

            if needs_refresh:
                new_token = await _try_refresh(client, current)
                if new_token is not None:
                    token, expires_in = new_token
                    expires_at = _iso(_now() + timedelta(seconds=expires_in))
                    store.save_token_state(handle, env_token, token, _iso(_now()), expires_at)
                    current = token
                    logger.info(
                        "refreshed IG graph token for @%s (expires_at=%s)", handle, expires_at
                    )

            result[handle] = current
    finally:
        if own_client:
            await client.aclose()
    return result


async def _try_refresh(
    http: httpx.AsyncClient, token: str
) -> tuple[str, int] | None:
    """refresh_access_token を1回試す。失敗は None (warning ログのみ)。"""
    try:
        response = await http.get(
            REFRESH_ENDPOINT,
            params={"grant_type": "ig_refresh_token", "access_token": token},
        )
        response.raise_for_status()
        payload = response.json()
        access_token = payload.get("access_token")
        expires_in = payload.get("expires_in")
        if not access_token or not isinstance(expires_in, int):
            logger.warning("refresh_access_token returned unexpected payload: %s", payload)
            return None
        return (str(access_token), expires_in)
    except Exception as exc:  # noqa: BLE001 - refresh 失敗で run は止めない
        logger.warning("token refresh failed (run continues with current token): %s", exc)
        return None
