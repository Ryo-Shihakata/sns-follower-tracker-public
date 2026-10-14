"""Workers API クライアント (docs/implementation-plan.md §5.5)。

書込系エンドポイント (`/accounts` `/settings` `/ingest`) は Bearer `INGEST_SECRET` で
認証する。読取系 (`/api/*`, `READ_API_TOKEN`) は外部ダッシュボード向けで collector は使わない。
"""

from __future__ import annotations

from typing import Any

import httpx


class WorkersClient:
    def __init__(self, base_url: str, ingest_secret: str, timeout: float = 15.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {ingest_secret}"}
        self._timeout = timeout

    async def get_accounts(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=self._timeout) as http:
            response = await http.get(f"{self._base_url}/accounts", headers=self._headers)
            response.raise_for_status()
            # worker は {"accounts": [...]} でラップして返す (§5.5)
            return response.json()["accounts"]

    async def get_settings(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as http:
            response = await http.get(f"{self._base_url}/settings", headers=self._headers)
            response.raise_for_status()
            # worker は {"settings": {...}} でラップして返す (§5.5)
            return response.json()["settings"]

    async def post_ingest(self, payload: dict[str, Any]) -> httpx.Response:
        async with httpx.AsyncClient(timeout=self._timeout) as http:
            response = await http.post(
                f"{self._base_url}/ingest", headers=self._headers, json=payload
            )
            response.raise_for_status()
            return response
