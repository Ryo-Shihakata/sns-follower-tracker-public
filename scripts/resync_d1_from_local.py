#!/usr/bin/env python3
"""ローカル SQLite の outbox 履歴から Workers /ingest へ再送し、D1 を再構築するスクリプト。

D1 消失時の復旧手段 (docs/implementation-plan.md §2 「データの正」)。
`outbox` テーブルは送信済み (sent=1) でも行を削除しない設計なので、実質的に全送信履歴の
ログとして使える。D1 側は UNIQUE 制約 + `ON CONFLICT DO NOTHING` で冪等なので、同じ
payload を何度再送しても安全 (collector の通常運転時の outbox flush と同じ考え方)。

実行例 (collector/ の venv を再利用する):
    cd collector
    uv run python ../scripts/resync_d1_from_local.py \
        --local-db /data/local.sqlite \
        --workers-base-url https://<your-worker>.workers.dev \
        --ingest-secret "$INGEST_SECRET"

先に --dry-run で送信件数だけ確認してから本実行するのを推奨する。
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# collector パッケージ (src レイアウト) を import できるようにする。
# `cd collector && uv run python ../scripts/...` で実行する場合は collector が既に
# editable install されているので不要だが、直接 `python scripts/...` されたときの保険。
_COLLECTOR_SRC = Path(__file__).resolve().parent.parent / "collector" / "src"
if str(_COLLECTOR_SRC) not in sys.path:
    sys.path.insert(0, str(_COLLECTOR_SRC))

from collector.client import WorkersClient  # noqa: E402
from collector.store import LocalStore  # noqa: E402

logger = logging.getLogger("resync_d1_from_local")


async def resync(
    local_db_path: str,
    workers_base_url: str,
    ingest_secret: str,
    dry_run: bool = False,
) -> tuple[int, int]:
    """ローカル DB の outbox 全件 (sent 済み含む) を /ingest に再送する。

    戻り値: (成功件数, 失敗件数)
    """
    client = WorkersClient(base_url=workers_base_url, ingest_secret=ingest_secret)

    with LocalStore(local_db_path) as store:
        rows = store.all_outbox()

    success = 0
    failure = 0
    for outbox_id, payload in rows:
        if dry_run:
            logger.info(
                "[dry-run] would resend outbox id=%s (snapshots=%d, runs=%d)",
                outbox_id,
                len(payload.get("snapshots", [])),
                len(payload.get("runs", [])),
            )
            success += 1
            continue
        try:
            await client.post_ingest(payload)
        except Exception as exc:  # noqa: BLE001 - 1件失敗しても残りは続行する
            failure += 1
            logger.error("failed to resend outbox id=%s: %s", outbox_id, exc)
            continue
        success += 1
        logger.info("resent outbox id=%s", outbox_id)

    return success, failure


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--local-db", required=True, help="ローカル SQLite (local.sqlite) のパス")
    parser.add_argument("--workers-base-url", required=True, help="Workers のベース URL")
    parser.add_argument("--ingest-secret", required=True, help="INGEST_SECRET")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="実際には送信せず、送信されるはずの件数だけ表示する",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO)
    args = build_arg_parser().parse_args(argv)

    success, failure = asyncio.run(
        resync(args.local_db, args.workers_base_url, args.ingest_secret, dry_run=args.dry_run)
    )
    logger.info("resync done: success=%d failure=%d", success, failure)
    return 0 if failure == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
