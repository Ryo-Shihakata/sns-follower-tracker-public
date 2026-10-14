"""共通データモデル。

docs/implementation-plan.md §5.1 の定義に準拠。プラットフォームごとの collector
(platforms/*.py) はここで定義された Metrics / PostMetrics を返す契約になっている。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class PostMetrics:
    """投稿1件分の公開指標 (最新12投稿分を Metrics.recent_posts に積む)。"""

    external_id: str
    url: str | None = None
    posted_at: str | None = None  # ISO8601
    media_type: str | None = None
    caption_head: str | None = None  # 先頭~80字 (一覧の識別用)
    caption_full: str | None = None  # 全文キャプション (投稿別分析の表示用)
    thumbnail_url: str | None = None  # サムネイル画像URL (署名付きで失効しうる。worker がプロキシ)
    likes: int | None = None  # いいね非表示の投稿は None
    comments: int | None = None
    views: int | None = None  # 動画のみ
    # 以下は managed アカウントの Instagram Graph API 取得時のみ入る
    # (docs/dashboard-v3-plan.md §4.2)。web collector は常に None のまま。
    reach: int | None = None
    impressions: int | None = None
    saved: int | None = None
    # docs/insights-reports-plan.md §2.1。follows/profile_visits はフィード投稿のみ
    # (リールは API 非対応)、watch time 2種はリールのみ。
    follows: int | None = None
    profile_visits: int | None = None
    shares: int | None = None
    total_interactions: int | None = None
    avg_watch_time_ms: int | None = None
    total_watch_time_ms: int | None = None


@dataclass
class Metrics:
    """1アカウント分の取得結果。"""

    followers: int
    following: int | None = None
    posts: int | None = None
    recent_posts: list[PostMetrics] = field(default_factory=list)
    source: str = ""
    # アカウントレベルの日次 Insights (managed アカウントの Graph API 取得時のみ)。
    # web collector は常に None。impressions/profile_views は Meta が 2025-04-21 に完全廃止し、
    # 後継の views に統合された (docs/dashboard-v3-plan.md §4.2, docs/gas-spreadsheet.md)。
    account_reach: int | None = None
    account_views: int | None = None
    # docs/insights-reports-plan.md §2.1 のアカウント日次 Insights 追加分。
    account_follows_gained: int | None = None
    account_follows_lost: int | None = None
    account_accounts_engaged: int | None = None
    account_total_interactions: int | None = None
    # フォロワー属性(週1回)/online_followers(1日1回)。docs/insights-reports-plan.md §2.1,§2.3。
    # 各要素は {"kind": ..., "bucket": ..., "value": ...} (ingest 契約に準拠)。
    # web collector および取得タイミングでない run では空リストのまま。
    audience_stats: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class RunResult:
    """1アカウントに対する1回の収集試行の結果 (成功/失敗を問わず記録する)。

    collection_runs (D1) / runs (ingest body) に対応。
    """

    platform: str
    handle: str
    ran_at: str  # ISO8601 UTC
    status: str  # 'ok' | 'fail'
    followers: int | None = None
    error: str | None = None
    latency_ms: int | None = None
