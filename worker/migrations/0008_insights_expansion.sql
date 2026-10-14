-- 投稿要因分析 + 定期レポート (docs/insights-reports-plan.md §2.3)。
--
-- 投稿別: follows(その投稿経由の新規フォロー) / profile_visits / shares /
--   total_interactions はフィード投稿のみ、watch time 2種はリールのみ入る
--   (Instagram Login API の対応状況は計画書 §7-1 の疎通検証結果を参照)。
-- アカウント日次: follows_gained/follows_lost(follows_and_unfollows の breakdown)、
--   accounts_engaged / total_interactions。
-- いずれも web collector 経路では常に NULL。

ALTER TABLE post_snapshots ADD COLUMN follows INTEGER;
ALTER TABLE post_snapshots ADD COLUMN profile_visits INTEGER;
ALTER TABLE post_snapshots ADD COLUMN shares INTEGER;
ALTER TABLE post_snapshots ADD COLUMN total_interactions INTEGER;
ALTER TABLE post_snapshots ADD COLUMN avg_watch_time_ms INTEGER;
ALTER TABLE post_snapshots ADD COLUMN total_watch_time_ms INTEGER;

ALTER TABLE snapshots ADD COLUMN follows_gained INTEGER;
ALTER TABLE snapshots ADD COLUMN follows_lost INTEGER;
ALTER TABLE snapshots ADD COLUMN accounts_engaged INTEGER;
ALTER TABLE snapshots ADD COLUMN total_interactions INTEGER;

-- フォロワー属性・オンライン時間帯 (P4 で収集開始。テーブルだけ先に用意)
CREATE TABLE audience_stats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  kind         TEXT NOT NULL,        -- 'demographics_age' | 'demographics_gender' | 'demographics_city' | 'online_followers'
  bucket       TEXT NOT NULL,        -- '13-17' | 'F' | 'Fukuoka' | '0'..'23'(時間帯)
  value        INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE (account_id, kind, bucket, collected_at)
);

-- 日次/週次/月次レポート (P2 で生成開始。テーブルだけ先に用意)
CREATE TABLE reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,        -- 'daily' | 'weekly' | 'monthly'
  period_start TEXT NOT NULL,        -- JST暦日 'YYYY-MM-DD'
  period_end   TEXT NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  metrics_json TEXT NOT NULL,
  llm_json     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, period_start, account_id)
);
