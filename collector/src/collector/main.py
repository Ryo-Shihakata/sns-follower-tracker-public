"""collector 全体のエントリポイント (docs/implementation-plan.md §2, §5.2, §5.4)。

ラン本体 (`run_full`) の流れ:
  1. Workers から `/accounts` `/settings` を取得
  2. 処理順をシャッフル (IP を焼かないための礼儀)
  3. アカウントごとに jitter 待機 -> 取得 (失敗時は指数バックオフで1回だけ再試行)
  4. 成功分はローカル SQLite (snapshots/post_snapshots) に必ず記録
  5. この run 分の snapshots/runs を outbox に積む
  6. 全滅 (成功0件) なら **ここで即中断** し、outbox は送らない (IP を焼かないため)
  7. 未送信の outbox をまとめて `/ingest` に flush、成功した分だけ sent 済みにする

`--dry-run` は実ネットワークアクセスなしのモック値でローカル保存だけ確認する。
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

from collector.client import WorkersClient
from collector.config import Settings
from collector.models import Metrics, PostMetrics
from collector.platforms.base import Collector
from collector.platforms.registry import build_collectors, build_graph_collectors, select_collector
from collector.store import LocalStore
from collector.token_refresh import refresh_graph_tokens

logger = logging.getLogger(__name__)

DEFAULT_JITTER_MIN_SECONDS = 30
DEFAULT_JITTER_MAX_SECONDS = 180
RETRY_BACKOFF_SECONDS = 2.0

# audience_stats (フォロワー属性/online_followers) の頻度制御 (docs/insights-reports-plan.md
# §2.1)。InstagramGraphCollector 自体は頻度を判断せず、ここで判定したフラグを注入する。
DEMOGRAPHICS_INTERVAL_DAYS = 7
ONLINE_FOLLOWERS_INTERVAL_DAYS = 1
_AUDIENCE_KIND_DEMOGRAPHICS = "demographics"
_AUDIENCE_KIND_ONLINE_FOLLOWERS = "online_followers"

# --dry-run 用の疎通確認先 (実 API は叩かない)。本番の対象アカウントは Workers /accounts から
# 取得する (run_full 参照)。
_DRY_RUN_HANDLES = ["example_account"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _post_metrics_to_dict(post: PostMetrics) -> dict[str, Any]:
    return {
        "external_id": post.external_id,
        "url": post.url,
        "posted_at": post.posted_at,
        "media_type": post.media_type,
        "caption_head": post.caption_head,
        "caption_full": post.caption_full,
        "thumbnail_url": post.thumbnail_url,
        "likes": post.likes,
        "comments": post.comments,
        "views": post.views,
        "reach": post.reach,
        "impressions": post.impressions,
        "saved": post.saved,
        "follows": post.follows,
        "profile_visits": post.profile_visits,
        "shares": post.shares,
        "total_interactions": post.total_interactions,
        "avg_watch_time_ms": post.avg_watch_time_ms,
        "total_watch_time_ms": post.total_watch_time_ms,
    }


def _metrics_to_snapshot_dict(
    platform: str, handle: str, collected_at: str, metrics: Metrics
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "platform": platform,
        "handle": handle,
        "collected_at": collected_at,
        "followers": metrics.followers,
        "following": metrics.following,
        "posts": metrics.posts,
        "reach": metrics.account_reach,
        "views": metrics.account_views,
        "follows_gained": metrics.account_follows_gained,
        "follows_lost": metrics.account_follows_lost,
        "accounts_engaged": metrics.account_accounts_engaged,
        "total_interactions": metrics.account_total_interactions,
        "source": metrics.source,
        "recent_posts": [_post_metrics_to_dict(p) for p in metrics.recent_posts],
    }
    # audience_stats (§2.1) は取得タイミングでない run では空リストのため、その場合は
    # キー自体を省略する (ingest 契約: optional キー)。
    if metrics.audience_stats:
        payload["audience_stats"] = metrics.audience_stats
    return payload


def _should_fetch_audience(
    store: LocalStore, handle: str, kind: str, now: datetime, interval_days: int
) -> bool:
    """audience_state を見て `kind` の取得タイミングが来ているか判定する (§2.1)。

    未取得 (記録なし) なら取得する。前回取得の **UTC暦日** から `interval_days` 日以上
    経っていれば取得する。timestamp が壊れている場合も安全側 (取得する) に倒す。

    経過時間(now - last).days ではなく暦日差で判定するのは、毎時 run と組み合わせたとき
    「前回取得が23時間前だと .days==0 で取得されず、翌日以降も収集時刻が毎日1時間ずつ
    後退する」ドリフトを避けるため。暦日差なら interval=1 は「日付が変われば必ず1回」に
    なる。
    """
    last = store.get_audience_last_fetched(handle, kind)
    if last is None:
        return True
    try:
        last_dt = datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    return (now.date() - last_dt.date()).days >= interval_days


async def _fetch_with_retry(
    collector: Collector, handle: str
) -> tuple[Metrics | None, str | None]:
    """1アカウント最大1回・指数バックオフでの再試行 (計画書 §5.2)。"""
    try:
        return await collector.fetch(handle), None
    except Exception as exc:  # noqa: BLE001 - 収集失敗はrun失敗として記録するため広く捕捉
        logger.warning("first attempt failed for @%s: %s", handle, exc)

    await asyncio.sleep(RETRY_BACKOFF_SECONDS)
    try:
        return await collector.fetch(handle), None
    except Exception as exc:  # noqa: BLE001
        logger.warning("retry failed for @%s: %s", handle, exc)
        return None, str(exc)


async def _flush_outbox(client: WorkersClient, store: LocalStore) -> None:
    for outbox_id, payload in store.pending_outbox():
        try:
            await client.post_ingest(payload)
        except Exception as exc:  # noqa: BLE001
            logger.error("failed to flush outbox id=%s: %s; will retry next run", outbox_id, exc)
            break
        store.mark_outbox_sent([outbox_id])
        logger.info("flushed outbox id=%s", outbox_id)


async def run_full(settings: Settings, graph_only: bool = False) -> int:
    """通常run (全アカウント) / graph_only run (managed の Graph API アカウントのみ)。

    graph_only は毎時 timer 用 (docs/insights-reports-plan.md §2.2)。公式APIのみを
    叩くため scraping 系の礼儀ルールの対象外だが、jitter は機械的アクセスパターンを
    避けるためそのまま適用する。insights は直近投稿に絞る (insights_scope="recent")。
    """
    if not settings.workers_base_url or not settings.ingest_secret:
        raise SystemExit("WORKERS_BASE_URL and INGEST_SECRET must be set for a full run")

    client = WorkersClient(settings.workers_base_url, settings.ingest_secret)
    accounts = await client.get_accounts()
    remote_settings = await client.get_settings()
    jitter_min = int(remote_settings.get("jitter_min_seconds", DEFAULT_JITTER_MIN_SECONDS))
    jitter_max = int(remote_settings.get("jitter_max_seconds", DEFAULT_JITTER_MAX_SECONDS))

    snapshots: list[dict[str, Any]] = []
    runs: list[dict[str, Any]] = []
    success_count = 0
    attempted_count = 0

    with LocalStore(settings.local_db_path) as store:
        # Graph トークンの自動 refresh (docs/insights-reports-plan.md §2.4)。
        # 失敗しても現行トークンで run を続行する。
        effective_tokens = await refresh_graph_tokens(settings.ig_graph_accounts, store)

        # audience_stats (フォロワー属性/online_followers) の頻度制御 (§2.1)。
        # graph_only (毎時) / 通常 run のどちらでも同じ判定が効く (audience_state は
        # 経路を問わず handle 単位で管理するため)。
        now = datetime.now(timezone.utc)
        audience_flags: dict[str, tuple[bool, bool]] = {
            handle: (
                _should_fetch_audience(
                    store, handle, _AUDIENCE_KIND_DEMOGRAPHICS, now, DEMOGRAPHICS_INTERVAL_DAYS
                ),
                _should_fetch_audience(
                    store,
                    handle,
                    _AUDIENCE_KIND_ONLINE_FOLLOWERS,
                    now,
                    ONLINE_FOLLOWERS_INTERVAL_DAYS,
                ),
            )
            for handle in settings.ig_graph_accounts
        }

        collectors = build_collectors(settings)
        graph_collectors = build_graph_collectors(
            settings,
            token_overrides=effective_tokens,
            insights_scope="recent" if graph_only else "full",
            audience_flags=audience_flags,
        )

        if graph_only:
            accounts = [
                a for a in accounts if a.get("managed") and a.get("handle") in graph_collectors
            ]
            if not accounts:
                logger.warning("--graph-only: no managed accounts with graph tokens; nothing to do")
                return 0

        shuffled_accounts = list(accounts)
        random.shuffle(shuffled_accounts)

        for account in shuffled_accounts:
            platform = account["platform_id"]
            handle = account["handle"]
            collector = select_collector(account, collectors, graph_collectors)
            if collector is None:
                logger.info("no collector registered for platform=%s handle=%s; skipping", platform, handle)
                continue

            attempted_count += 1
            await asyncio.sleep(random.uniform(jitter_min, jitter_max))

            ran_at = _now_iso()
            start = time.monotonic()
            metrics, error = await _fetch_with_retry(collector, handle)
            latency_ms = int((time.monotonic() - start) * 1000)

            if metrics is not None:
                success_count += 1
                collected_at = _now_iso()
                store.save_metrics(platform, handle, collected_at, metrics)
                # 今回の run で demographics/online_followers の取得を指示した handle は、
                # 結果の有無にかかわらず「取得を試みた」ことを記録し、次回の頻度判定に使う。
                if handle in audience_flags:
                    fetch_demographics, fetch_online_followers = audience_flags[handle]
                    if fetch_demographics:
                        store.mark_audience_fetched(
                            handle, _AUDIENCE_KIND_DEMOGRAPHICS, collected_at
                        )
                    if fetch_online_followers:
                        store.mark_audience_fetched(
                            handle, _AUDIENCE_KIND_ONLINE_FOLLOWERS, collected_at
                        )
                snapshots.append(_metrics_to_snapshot_dict(platform, handle, collected_at, metrics))
                runs.append(
                    {
                        "platform": platform,
                        "handle": handle,
                        "ran_at": ran_at,
                        "status": "ok",
                        "followers": metrics.followers,
                        "latency_ms": latency_ms,
                    }
                )
            else:
                runs.append(
                    {
                        "platform": platform,
                        "handle": handle,
                        "ran_at": ran_at,
                        "status": "fail",
                        "error": error,
                        "latency_ms": latency_ms,
                    }
                )

        if attempted_count == 0:
            logger.warning("no accounts had a matching collector; nothing to do")
            return 0

        store.enqueue_outbox({"snapshots": snapshots, "runs": runs}, _now_iso())

        if success_count == 0:
            logger.error(
                "all %d attempted accounts failed this run; aborting before contacting "
                "/ingest (avoid burning IP). Data stays queued in the local outbox.",
                attempted_count,
            )
            return 1

        await _flush_outbox(client, store)

    return 0


def _dry_run_metrics(handle: str) -> Metrics:
    """--dry-run 用のモック取得結果。ネットワークアクセスは一切行わない。"""
    return Metrics(
        followers=1234,
        following=10,
        posts=88,
        recent_posts=[
            PostMetrics(
                external_id="DRYRUNSHORTCODE",
                url="https://www.instagram.com/p/DRYRUNSHORTCODE/",
                posted_at="2026-07-01T09:00:00Z",
                media_type="image",
                caption_head=f"dry-run sample caption for @{handle}",
                likes=321,
                comments=12,
                views=None,
            )
        ],
        source="dry-run",
    )


async def run_dry_run(settings: Settings) -> None:
    collected_at = _now_iso()
    with LocalStore(settings.local_db_path) as store:
        for handle in _DRY_RUN_HANDLES:
            metrics = _dry_run_metrics(handle)
            store.save_metrics("instagram", handle, collected_at, metrics)
            logger.info(
                "dry-run: saved metrics for @%s (followers=%s, posts=%s)",
                handle,
                metrics.followers,
                len(metrics.recent_posts),
            )
    logger.info("dry-run complete: nothing was sent to /ingest (db=%s)", settings.local_db_path)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="collector")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="実際の取得・送信を行わず、モック値のローカル SQLite 保存だけ確認する",
    )
    parser.add_argument(
        "--graph-only",
        action="store_true",
        help="managed の Graph API アカウントだけを収集する (毎時 timer 用)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO)
    args = build_arg_parser().parse_args(argv)
    settings = Settings.from_env()
    logging.getLogger().setLevel(settings.log_level)

    if args.dry_run:
        asyncio.run(run_dry_run(settings))
        return 0

    return asyncio.run(run_full(settings, graph_only=args.graph_only))


if __name__ == "__main__":
    raise SystemExit(main())
