-- 計画書 docs/implementation-plan.md §4.1 のDDLをそのまま適用
CREATE TABLE platforms (
  id      TEXT PRIMARY KEY,          -- 'instagram' | 'youtube' | ...
  name    TEXT NOT NULL
);

-- 監視対象。ダッシュボードの管理パネル or /accounts API から随時変更する。
CREATE TABLE accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_id  TEXT NOT NULL REFERENCES platforms(id),
  handle       TEXT NOT NULL,        -- IG:ユーザー名 / YT:channelId or @handle
  display_name TEXT,
  active       INTEGER NOT NULL DEFAULT 1,   -- 0で収集対象外
  managed      INTEGER NOT NULL DEFAULT 0,   -- 1=自分(の組織)が管理 → Graph API対象候補
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (platform_id, handle)
);

-- アカウント単位の時系列 (フォロワー数など)
CREATE TABLE snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  collected_at  TEXT NOT NULL,       -- ISO8601 UTC
  followers     INTEGER NOT NULL,
  following     INTEGER,
  posts         INTEGER,
  source        TEXT,                -- 'ig-web' | 'ig-browser' | 'ig-graph' | 'yt-api'
  UNIQUE (account_id, collected_at)
);
CREATE INDEX idx_snapshots_account_time ON snapshots(account_id, collected_at);

-- 投稿マスタ (発見した投稿。最新12件ずつ増分的に溜まる)
CREATE TABLE posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  external_id  TEXT NOT NULL,        -- IG: media shortcode
  url          TEXT,
  posted_at    TEXT,
  media_type   TEXT,                 -- 'image' | 'video' | 'carousel'
  caption_head TEXT,                 -- キャプション先頭~80字 (識別用)
  UNIQUE (account_id, external_id)
);

-- 投稿単位の時系列 (公開指標 + 管理アカのみ Insights 列)
CREATE TABLE post_snapshots (
  post_id       INTEGER NOT NULL REFERENCES posts(id),
  collected_at  TEXT NOT NULL,
  likes         INTEGER,             -- 非表示設定の投稿は NULL
  comments      INTEGER,
  views         INTEGER,             -- 動画のみ
  reach         INTEGER,             -- 以下3列は managed アカの Graph API 取得時のみ
  impressions   INTEGER,
  saved         INTEGER,
  source        TEXT,
  PRIMARY KEY (post_id, collected_at)
);

-- 収集ランの記録 (可観測性・鮮度点検)
CREATE TABLE collection_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER REFERENCES accounts(id),
  ran_at        TEXT NOT NULL,
  status        TEXT NOT NULL,       -- 'ok' | 'fail'
  followers     INTEGER,
  error         TEXT,
  latency_ms    INTEGER
);
CREATE INDEX idx_runs_account_time ON collection_runs(account_id, ran_at);

-- 異常イベント (通知の実体。ダッシュボード表示 + /api/events で外部提供)
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,       -- 'collect_fail' | 'anomaly' | 'stale'
  account_id    INTEGER REFERENCES accounts(id),
  message       TEXT NOT NULL,       -- 人間可読 (例: '@x フォロワー +12% (1200→1344)')
  payload_json  TEXT,                -- 数値詳細 (prev/new/delta等)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_time ON events(created_at);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO platforms (id, name) VALUES ('instagram','Instagram'), ('youtube','YouTube');
INSERT INTO settings (key, value) VALUES
  ('jitter_min_seconds', '30'),
  ('jitter_max_seconds', '180'),
  ('anomaly_pct_threshold', '0.10'),
  ('anomaly_abs_min', '50'),
  ('freshness_hours', '30');
