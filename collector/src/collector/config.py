"""環境変数からの設定読み込み (docs/implementation-plan.md §11)。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    """`.env` があれば読み込み、既存の環境変数は上書きしない。

    docker-compose の `env_file:` を使う本番運用ではコンテナ起動時点で環境変数が
    セットされているためこの関数は素通りになる。開発機で docker を使わず直接
    `python -m collector.main` を叩くときの利便性のためだけに存在する。
    """
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


# Graph API 管理アカウントのデフォルト handle。
# レガシー互換: IG_GRAPH_TOKEN / IG_GRAPH_USER_ID (サフィックスなし) はこの handle に紐付く。
DEFAULT_IG_GRAPH_HANDLE = "example_account"


def _normalize_handle(handle: str) -> str:
    """handle を環境変数サフィックスに使える形へ正規化する。

    Instagram handle は `[a-z0-9._]` を含みうるが環境変数名に `.` は使えないため、
    英数字以外を `_` に潰して大文字化する。例: `example_account_b` ->
    `HIGASHIFUKUOKA_SEITOKAI`、`some.handle` -> `SOME_HANDLE`。
    """
    return "".join(ch if ch.isalnum() else "_" for ch in handle).upper()


@dataclass(frozen=True)
class Settings:
    workers_base_url: str
    ingest_secret: str
    youtube_api_key: str | None
    ig_sessionid: str | None
    local_db_path: str
    log_level: str
    # 手段3 (ステルスブラウザ) を使うかどうか。既定 OFF (docs/implementation-plan.md §5.2)。
    ig_enable_stealth: bool = False
    # Instagram Graph API (managed アカウント用、docs/dashboard-v3-plan.md §4.3)。
    # レガシー単一アカウント用: IG_GRAPH_TOKEN / IG_GRAPH_USER_ID (example_account に紐付く)。
    ig_graph_token: str | None = None
    ig_graph_user_id: str | None = None
    # 複数アカウント用: IG_GRAPH_ACCOUNTS に列挙した handle ごとの (handle, token, ig_user_id)。
    # 後からどのアカウントでも 2 つの環境変数を足すだけで Graph API に切り替えられる。
    ig_graph_accounts_map: tuple[tuple[str, str, str], ...] = ()

    @classmethod
    def from_env(cls, dotenv_path: str | Path | None = None) -> "Settings":
        _load_dotenv(Path(dotenv_path) if dotenv_path is not None else Path(".env"))
        return cls(
            workers_base_url=os.environ.get("WORKERS_BASE_URL", "").rstrip("/"),
            ingest_secret=os.environ.get("INGEST_SECRET", ""),
            youtube_api_key=os.environ.get("YOUTUBE_API_KEY") or None,
            ig_sessionid=os.environ.get("IG_SESSIONID") or None,
            ig_enable_stealth=os.environ.get("IG_ENABLE_STEALTH", "").strip().lower()
            in ("1", "true", "yes"),
            local_db_path=os.environ.get("LOCAL_DB_PATH", "./local.sqlite"),
            log_level=os.environ.get("COLLECTOR_LOG_LEVEL", "INFO"),
            ig_graph_token=os.environ.get("IG_GRAPH_TOKEN") or None,
            ig_graph_user_id=os.environ.get("IG_GRAPH_USER_ID") or None,
            ig_graph_accounts_map=cls._parse_graph_accounts(),
        )

    @staticmethod
    def _parse_graph_accounts() -> tuple[tuple[str, str, str], ...]:
        """`IG_GRAPH_ACCOUNTS` (カンマ区切り handle) から handle 単位のトークンを読む。

        各 handle H について `IG_GRAPH_TOKEN_<norm(H)>` と `IG_GRAPH_USER_ID_<norm(H)>`
        の両方が揃っているものだけを採用する (片方だけなら黙って除外)。
        """
        raw = os.environ.get("IG_GRAPH_ACCOUNTS", "")
        out: list[tuple[str, str, str]] = []
        for handle in (h.strip() for h in raw.split(",")):
            if not handle:
                continue
            norm = _normalize_handle(handle)
            token = os.environ.get(f"IG_GRAPH_TOKEN_{norm}")
            user_id = os.environ.get(f"IG_GRAPH_USER_ID_{norm}")
            if token and user_id:
                out.append((handle, token, user_id))
        return tuple(out)

    @property
    def ig_graph_accounts(self) -> dict[str, dict[str, str]]:
        """handle -> {"token": ..., "ig_user_id": ...} のマップ。

        レガシーの IG_GRAPH_TOKEN/IG_GRAPH_USER_ID を DEFAULT_IG_GRAPH_HANDLE
        (example_account) に紐付けたうえで、IG_GRAPH_ACCOUNTS 由来の handle 単位設定を
        重ねる (同一 handle は handle 単位設定が優先)。どちらも無ければ空
        (= Graph collector は使われず web collector にフォールバック)。
        """
        out: dict[str, dict[str, str]] = {}
        if self.ig_graph_token and self.ig_graph_user_id:
            out[DEFAULT_IG_GRAPH_HANDLE] = {
                "token": self.ig_graph_token,
                "ig_user_id": self.ig_graph_user_id,
            }
        for handle, token, user_id in self.ig_graph_accounts_map:
            out[handle] = {"token": token, "ig_user_id": user_id}
        return out
