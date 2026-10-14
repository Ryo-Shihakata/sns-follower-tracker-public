"""Collector プラグイン基底 (docs/implementation-plan.md §5.1, §7)。

新しい SNS を追加する手順:
  1. この Collector を実装した <sns>.py を作る
  2. registry.py に登録する
  3. D1 の platforms テーブルに1行追加する (worker/ 側の作業)
ダッシュボード・ingest 契約は platform 非依存なので、上記だけで完結する。
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from collector.models import Metrics


class Collector(ABC):
    """1プラットフォーム分の取得ロジック。"""

    platform_id: str

    @abstractmethod
    async def fetch(self, handle: str) -> Metrics:
        """指定ハンドル/チャンネルの現在のフォロワー数+最新投稿指標を取得する。

        取得できない/ブロックされた等は例外を送出する (呼び出し側で run 失敗として記録する)。
        """
        ...
