# SNS フォロワー推移トラッカー — 実装計画書 v2（agent 向け）

最終更新: 2026-07-05 / 対象実装者: coding agent

このドキュメントは、agent が上から順に実装できる粒度で書かれた実装計画書である。
「なぜこの構成か」「何を作るか」「どう検証するか」をすべて含む。曖昧な箇所は
本書の「決定事項」に従い、勝手な再解釈をしないこと。

v2 変更点: OS 確定(Ubuntu Server) / 通知は「イベント」として D1 に保存し
ダッシュボード表示+APIで外部提供(Discord/LINE は将来のチャネルアダプタ) /
投稿ごとの指標(公開指標+管理アカは真の Insights)を追加 / 初期5アカウント確定。

---

## 0. ゴール（1段落）

複数の**他人の Instagram アカウント**のフォロワー数と**投稿ごとの公開指標
(いいね・コメント・再生数)**を **1日数回**自動取得し、**時系列の表+推移グラフ**で
閲覧できるようにする。取得は **Instagram の API 制限・ブロックに極力かからない方法**で
行い、**将来的に YouTube など他 SNS を追加**できるプラグイン構造にする。
取得失敗・急変動などの異常は**イベント**としてダッシュボードに表示し、
**API 経由で別のダッシュボードからも取得できる**ようにする(将来 Discord/LINE 通知に拡張)。
自分(の組織)が**管理しているアカウント**は、公式 Graph API で真のインサイト
(リーチ・保存数等)も取れるよう拡張口を用意する。

---

## 1. 確定した設計判断（grill-me で合意済み。再検討不要）

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| D1 | 取得の実行場所 | **自宅サーバー**（GAS は不使用） | Google/CF のデータセンター IP は Instagram にブロックされる。住宅 IP なら生存率が高い |
| D2 | 保存・可視化 | **Cloudflare をメイン**（Workers + D1 + ダッシュボード）、**自宅 SQLite をバックアップ**として並行記録 | どこからでも閲覧でき、既存スタック（Hono+Workers+D1）と一致。生データも手元に残す |
| D3 | 規模・頻度 | **~20 アカウント / 1日数回**。件数・頻度は**設定で後から変更可能** | 推移グラフには十分。対象は D1 の `accounts` とダッシュボードの管理パネルで随時変更 |
| D4 | ログイン | **未ログイン主体**（TLS 偽装 HTTP → 必要時ステルスブラウザ）。**セッション注入は後付けオプション** | BAN リスクを負わずに開始。本人常用アカウントは絶対に使わない |
| D5 | 取得サーバー環境 | **Ubuntu Server + Docker**（Docker Compose でコンテナ化、systemd timer 起動） | 依存を閉じ込め可搬に。他 SNS モジュール追加が楽 |
| D6 | 通知/異常検知 | **イベントを D1 に保存 → ダッシュボード表示 + `GET /api/events` で外部提供**。Discord/LINE は**チャネルアダプタ**として将来追加(送信 IF だけ今切る) | 「別のダッシュボードにも表示したい」要件を API ファーストで満たす |
| D7 | 他 SNS 拡張 | **YouTube を第一候補**（公式 Data API）。**プラグイン式で任意 SNS を追加可能** | 取得難易度の差は collector 実装内に隠蔽 |
| D8 | 投稿ごとの指標 | **全アカウント: 公開指標**(いいね・コメント・再生数。`web_profile_info` に最新12投稿分が同梱＝追加リクエストゼロ)。**管理アカウント: 公式 Instagram Graph API で真の Insights**(リーチ・保存数等)をオプション拡張 | 他人のアカウントの真のインサイトは原理的に取得不可。公開指標は無コストで取れる |
| D9 | 初期対象 | 下記 5 アカウント(§4.3 シード) | ユーザー指定 |

**初期対象アカウント(Instagram)**:
`example_account` / `fukuoka_jyoto_official` / `example_account_a` /
`example_account_b` / `fukuoka_kogyodaigaku`

**スコープ外（今回作らない）**: フォロワーの属性分析、複数ユーザー向け認証付き
サービス化。Discord/LINE の実送信はチャネル IF だけ用意し実装は後続
(どのアカウントが「管理アカ」かはユーザー確認待ち → Graph API 連携はフェーズ6)。

---

## 2. アーキテクチャ全体像

```
┌──────────────────────── 自宅サーバー (Ubuntu Server + Docker) ────────────────┐
│                                                                              │
│   [systemd timer]  ──trigger──▶  collector コンテナ (Python, 1回走って終了)  │
│                                          │                                   │
│                                          │ 1. GET /accounts, /settings       │
│                                          │ 2. platform 別 collector で取得   │
│                                          │    (フォロワー数 + 最新12投稿指標)│
│                                          │ 3. ローカル SQLite に必ず記録     │
│                                          │ 4. Workers /ingest にバッチ POST  │
│                                          ▼                                   │
│                                    local.sqlite (バックアップ/outbox)        │
└──────────────────────────────────────────┼──────────────────────────────────┘
                                            │ HTTPS + Bearer INGEST_SECRET
                                            ▼
┌──────────────────────────── Cloudflare ─────────────────────────────────────┐
│   Workers (Hono)                     D1 (SQLite)                             │
│   ├─ POST /ingest ─────書込──▶  accounts / snapshots / posts /               │
│   │    └─ 急変動判定 → events    post_snapshots / collection_runs /          │
│   ├─ GET  /accounts /settings    events / settings                           │
│   ├─ GET  /api/series /api/posts /api/events   ← 外部ダッシュボードも利用可  │
│   ├─ GET  /  ダッシュボード(グラフ+表+イベント+アカウント管理パネル)         │
│   └─ [将来] channel dispatcher → Discord / LINE アダプタ                     │
│   Cron Trigger (1日1回): 鮮度点検 → 停止疑いを events へ                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**データの正**: D1 が primary。自宅 SQLite は (a) 送信前 outbox、(b) 冗長バックアップ。
D1 消失時は `scripts/resync_d1_from_local.py` で再構築。

---

## 3. リポジトリ構成

単一リポジトリ（monorepo）。`worker/` と `collector/` は互いに独立に実装できる
（契約は §4 スキーマと §5.5 API 仕様）。

```
sns-follower-tracker/
├── README.md / CLAUDE.md / .gitignore
├── docs/implementation-plan.md        # 本書
├── collector/                         # 自宅サーバー側 (Python)
│   ├── pyproject.toml                 # uv 管理
│   ├── Dockerfile / docker-compose.yml / .env.example
│   ├── deploy/systemd/                # collector.service / collector.timer サンプル
│   ├── src/collector/
│   │   ├── main.py                    # 1回の収集ラン全体
│   │   ├── config.py / client.py / store.py / models.py
│   │   └── platforms/
│   │       ├── base.py                # Collector 抽象基底
│   │       ├── registry.py
│   │       ├── instagram.py           # 未ログイン主体 (followers + 最新12投稿)
│   │       ├── instagram_graph.py     # [フェーズ6] 管理アカ用 Graph API
│   │       └── youtube.py             # 公式 Data API
│   └── tests/                         # 固定フィクスチャによるパーステスト等
├── worker/                            # Cloudflare 側 (TypeScript + Hono)
│   ├── package.json / wrangler.jsonc / tsconfig.json
│   ├── migrations/
│   │   ├── 0001_init.sql
│   │   └── 0002_seed_accounts.sql
│   └── src/
│       ├── index.ts                   # Hono app + scheduled handler
│       ├── routes/ (ingest.ts / accounts.ts / series.ts / posts.ts /
│       │            events.ts / dashboard.ts)
│       ├── lib/ (auth.ts / anomaly.ts / events.ts / channels/
│       │         ├── base.ts          # Channel IF: send(event)
│       │         ├── discord.ts       # [将来] スタブのみ
│       │         └── line.ts          # [将来] スタブのみ
│       └── cron.ts                    # 鮮度点検
└── scripts/resync_d1_from_local.py
```

---

## 4. データモデル

### 4.1 D1 スキーマ（`worker/migrations/0001_init.sql`）

```sql
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
```

### 4.2 自宅ローカル SQLite（`collector/src/collector/store.py`）

D1 の `snapshots`/`post_snapshots` 相当（`account_key = 'instagram:handle'` 形式で
D1 の id に依存しない）+ **outbox（未送信キュー）**。

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  account_key TEXT NOT NULL, collected_at TEXT NOT NULL,
  followers INTEGER NOT NULL, following INTEGER, posts INTEGER, source TEXT,
  PRIMARY KEY (account_key, collected_at));
CREATE TABLE IF NOT EXISTS post_snapshots (
  account_key TEXT NOT NULL, external_id TEXT NOT NULL, collected_at TEXT NOT NULL,
  url TEXT, posted_at TEXT, media_type TEXT, caption_head TEXT,
  likes INTEGER, comments INTEGER, views INTEGER, source TEXT,
  PRIMARY KEY (account_key, external_id, collected_at));
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0);
```

**冪等性**: D1 側は UNIQUE 制約 + `ON CONFLICT DO NOTHING`。outbox 再送で重複しても安全。

### 4.3 初期シード（`worker/migrations/0002_seed_accounts.sql`）

```sql
INSERT INTO accounts (platform_id, handle, active) VALUES
 ('instagram','example_account',1),
 ('instagram','fukuoka_jyoto_official',1),
 ('instagram','example_account_a',1),
 ('instagram','example_account_b',1),
 ('instagram','fukuoka_kogyodaigaku',1);
```

---

## 5. コンポーネント詳細

### 5.1 Collector — プラグイン基底（`platforms/base.py`）

```python
@dataclass
class PostMetrics:
    external_id: str
    url: str | None = None
    posted_at: str | None = None       # ISO8601
    media_type: str | None = None
    caption_head: str | None = None
    likes: int | None = None           # 非表示なら None
    comments: int | None = None
    views: int | None = None

@dataclass
class Metrics:
    followers: int
    following: int | None = None
    posts: int | None = None
    recent_posts: list[PostMetrics] = field(default_factory=list)
    source: str = ""

class Collector(ABC):
    platform_id: str
    @abstractmethod
    async def fetch(self, handle: str) -> Metrics: ...
```

新 SNS 追加は「`Collector` 実装 + `registry.py` 登録 + D1 `platforms` に1行」だけ。

### 5.2 Collector — Instagram（`platforms/instagram.py`）

**取得戦略（フォールバックチェーン。上から順に試す）**:

1. **未ログイン Web JSON API**（本命）
   `GET https://www.instagram.com/api/v1/users/web_profile_info/?username=<handle>`
   - **Scrapling** の TLS/JA3 偽装 HTTP クライアントで実行。
   - 必須ヘッダ: `x-ig-app-id: 936619743392459`、ブラウザ相当 `User-Agent`、`Accept-Language`。
   - `data.user.edge_followed_by.count` → followers。
   - **同レスポンスの `data.user.edge_owner_to_timeline_media.edges`(最新12投稿)から
     `shortcode` / `taken_at_timestamp` / `__typename` / `edge_liked_by.count`(or
     `edge_media_preview_like.count`) / `edge_media_to_comment.count` /
     `video_view_count` / caption を抽出** → `recent_posts`。
     いいね非表示(count が -1 や欠落)は `likes=None` として保存。
2. **未ログイン HTML 埋め込み**（1 が死んだ時): プロフィール HTML から埋め込み JSON/meta 抽出。
3. **ステルスブラウザ**（最終手段・設定で有効化): Scrapling StealthyFetcher。頻度を絞る。
4. **（後付けオプション）ログインセッション注入**: `IG_SESSIONID` 設定時のみ Cookie 付与。
   捨てアカ専用・既定 OFF。

**礼儀・生存率のための必須ルール**:
- アカウント間に `jitter_min..jitter_max` 秒のランダム待機、処理順もシャッフル。
- 1ランで全滅したら**即中断**して fail イベント送信。IP を焼かない。
- リトライは1アカウント最大1回・指数バックオフ。
- パースは**固定フィクスチャのユニットテスト必須**（構造変化時にフィクスチャ差し替えで追随）。

### 5.3 Collector — Instagram Graph API（`platforms/instagram_graph.py`、フェーズ6）

`accounts.managed=1` かつ `IG_GRAPH_TOKEN_<HANDLE>`（または設定ファイル）がある
アカウントのみ対象。公式 **Instagram Graph API** で:
- `GET /{ig-user-id}?fields=followers_count,media_count`
- `GET /{ig-user-id}/media?fields=id,permalink,timestamp,media_type,caption,like_count,comments_count`
- `GET /{ig-media-id}/insights?metric=reach,impressions,saved`
前提: 対象がビジネス/クリエイターアカウント + Facebook ページ連携 + Meta アプリと
長期トークン。セットアップ手順は実装時に `docs/graph-api-setup.md` として書く。
未設定なら通常の未ログイン collector にフォールバック（＝壊れない）。

### 5.4 Collector — YouTube（`platforms/youtube.py`）

公式 **YouTube Data API v3**: `channels?part=statistics` → `subscriberCount`
（丸め値である旨を `source='yt-api'` で識別）。`@handle` は `forHandle` で解決。
`YOUTUBE_API_KEY` 未設定なら youtube collector は無効。

### 5.5 Worker — API（契約。collector/外部ダッシュボードとの境界）

| メソッド | パス | 認証 | 役割 |
|---------|------|------|------|
| POST | `/ingest` | Bearer `INGEST_SECRET` | snapshots+post_snapshots+runs を受領→upsert→急変動判定→events 記録 |
| GET | `/accounts` | Bearer `INGEST_SECRET` | active なアカウント一覧（collector 用。managed 含む全属性） |
| GET | `/settings` | Bearer `INGEST_SECRET` | settings を JSON で |
| POST | `/accounts` | Bearer `INGEST_SECRET` | アカウント追加 |
| PATCH | `/accounts/:id` | Bearer `INGEST_SECRET` | active/managed/display_name 変更 |
| GET | `/api/series?account_id=&from=&to=` | Bearer `READ_API_TOKEN` | フォロワー時系列 JSON（**外部ダッシュボード用**） |
| GET | `/api/posts?account_id=&limit=` | Bearer `READ_API_TOKEN` | 投稿一覧+最新指標（外部提供） |
| GET | `/api/posts/:post_id/series` | Bearer `READ_API_TOKEN` | 投稿単位の指標時系列 |
| GET | `/api/events?since=&type=` | Bearer `READ_API_TOKEN` | 異常イベント（**外部ダッシュボード用**） |
| GET | `/` ほか UI | Cloudflare Access | ダッシュボード HTML |

- 認証は2系統: 書込系=`INGEST_SECRET`、読取系=`READ_API_TOKEN`（別のダッシュボードには
  読取トークンだけ渡せる）。ダッシュボード UI 自体は Cloudflare Access で保護し、
  UI→自 API 呼び出しは同一オリジンのセッションで許可（実装時は Access JWT 検証 or
  UI 専用パス）。CORS は `/api/*` のみ許可オリジン設定可能に。

**レスポンス形状(確定。実装済み)**: `GET /accounts` は `{"accounts":[...]}`、
`GET /settings` は `{"settings":{...}}`、`GET /api/series` は `{"series":[...]}`、
`GET /api/events` は `{"events":[...]}` と、**すべてキーでラップして返す**。
collector 側はアンラップして使う(client.py)。

`/ingest` body 例:
```json
{ "snapshots": [ { "platform":"instagram", "handle":"example_account",
    "collected_at":"2026-07-05T02:15:03Z", "followers":1234, "following":10,
    "posts":88, "source":"ig-web",
    "recent_posts":[ { "external_id":"C8abc...", "url":"https://www.instagram.com/p/C8abc/",
      "posted_at":"2026-07-01T09:00:00Z", "media_type":"image",
      "caption_head":"体育祭...", "likes":321, "comments":12, "views":null } ] } ],
  "runs": [ { "platform":"instagram","handle":"example_account","ran_at":"...",
    "status":"ok","followers":1234,"latency_ms":812 } ] }
```
未登録 handle は 400（自動作成しない。アカウント管理は明示的に行う）。

### 5.6 急変動判定（`worker/src/lib/anomaly.ts`）

ingest 時に直前スナップショットと比較:
`pct >= anomaly_pct_threshold` **かつ** `|delta| >= anomaly_abs_min` →
`events(type='anomaly')` を作成。閾値は `settings` から。

### 5.7 鮮度点検（`worker/src/cron.ts`、Cron Trigger 1日1回）

active アカウントごとに最新の成功 run を確認し、`freshness_hours` 超過なら
`events(type='stale')`。「黙って止まる」をここで防ぐ。

### 5.8 イベント配信（`worker/src/lib/events.ts` + `channels/`）

- events への書込を一元化する `emitEvent()` を用意。
- `Channel` インターフェース（`send(event): Promise<void>`）を切り、
  **discord.ts / line.ts はスタブ**（TODO コメントと必要 secret 名だけ記述）。
  将来 `settings` の `channels_enabled` で有効化する設計にする。
- 当面の「通知」= ダッシュボードのイベントパネル + `GET /api/events`。

### 5.9 ダッシュボード（`worker/src/routes/dashboard.ts`）

単一ページ（外部 CDN 不可なら Chart.js をバンドル/インライン）:
1. **フォロワー推移グラフ**（複数アカウント重ね描き、期間選択、platform 混在可）
2. **日次テーブル**（アカウント×日付のフォロワー数、前日比）
3. **投稿ビュー**: アカウント選択 → 最新投稿の一覧（いいね/コメント/再生数の現在値と
   スパークライン。managed アカは reach/saved 列も表示）
4. **イベントパネル**: 最新イベント一覧（type バッジ、acknowledged 切替）
5. **アカウント管理パネル**: 追加フォーム / active トグル / managed トグル
   （＝「管理対象は簡単に変更できるように」の実体。D1 直編集不要）
ライト/ダーク両対応。

---

## 6. 認証・秘密管理

| 秘密 | 置き場所 | 使う側 |
|------|---------|--------|
| `INGEST_SECRET` | Workers secret + collector `.env` | collector→Workers（書込系） |
| `READ_API_TOKEN` | Workers secret + 外部ダッシュボード | 読取系 API |
| `YOUTUBE_API_KEY` | collector `.env` | youtube collector |
| `IG_SESSIONID`（任意・既定なし） | collector `.env` | IG collector 後付けオプション |
| `IG_GRAPH_TOKEN_*`（フェーズ6） | collector `.env` | 管理アカの Graph API |
| Cloudflare Access ポリシー | CF ダッシュボード | UI 保護（許可: you@example.com） |

`.env` はコミット禁止。`.env.example` のみ配布。Workers secret は `wrangler secret put`。

---

## 7. 拡張性: 新しい SNS / 通知チャネルの追加手順

**SNS 追加**: ① `platforms/<sns>.py` に `Collector` 実装 → ② `registry.py` 登録 →
③ D1 `platforms` に1行 → ④ `accounts` に対象追加。ダッシュボードは platform 非依存で変更不要。

**通知チャネル追加（Discord/LINE）**: ① `channels/<name>.ts` に `Channel.send()` 実装
（Discord=Webhook POST、LINE=Messaging API push + channel token）→ ② secret 追加 →
③ `settings.channels_enabled` に名前を足す。events の発生側は変更不要。

---

## 8. 実装フェーズ（agent 向けタスク分解）

`worker/` と `collector/` は §4/§5.5 の契約に基づき**並行実装可能**。
各フェーズ末尾の完了条件を満たすまで次に進まない。

### トラック W（worker/ 担当）
- **W1: D1 スキーマ + API 骨格** — migrations 0001/0002、`/ingest` `/accounts`
  `/settings`、Bearer 2系統認証、急変動判定 + events 記録。
  完了条件: `wrangler dev` + ローカル D1 で curl による account 登録 → ingest →
  snapshots/post_snapshots/events が入ることを確認（コマンドと出力を記録）。
- **W2: 読取 API + ダッシュボード** — `/api/series` `/api/posts` `/api/events`、
  ダッシュボード5要素（§5.9）。
  完了条件: ダミー時系列（数アカウント×数週間+投稿指標）を投入し、グラフ・表・
  投稿ビュー・イベント・管理パネルが機能する（スクリーンショット確認）。
- **W3: cron 鮮度点検 + チャネル IF** — `cron.ts`、`emitEvent()`、channels スタブ。
  完了条件: 古い run しかないアカウントで scheduled 実行 → stale イベントが入る
  （`wrangler dev --test-scheduled` で検証）。

### トラック C（collector/ + scripts/ 担当）
- **C1: 骨格 + IG collector 本命パス** — pyproject、config、models、base/registry、
  instagram.py の手段1（web_profile_info、followers + 最新12投稿パース）、
  固定フィクスチャのユニットテスト、ローカル SQLite store + outbox。
  完了条件: ユニットテスト green。`--dry-run`（送信なし・ローカル保存のみ）が動く。
- **C2: Workers 連携 + ラン本体** — client.py、main.py（シャッフル/jitter/全滅中断/
  outbox flush/runs 報告）、YouTube collector。
  完了条件: モック HTTP サーバー（または wrangler dev）相手に ingest まで通る
  統合テスト。実 Instagram への live smoke test は**任意**（1アカウントのみ・1回）。
- **C3: 運用パッケージ** — Dockerfile/compose、systemd timer サンプル
  （02:15/10:15/18:15 + RandomizedDelaySec）、`resync_d1_from_local.py`、README 運用手順。
  完了条件: `docker compose run collector` が動く。resync のユニットテスト。

### 統合フェーズ（両トラック完了後）
- **I1**: `wrangler dev` + 実 collector（live 1回 or フィクスチャ注入）で end-to-end。
  ダッシュボードに実データが出ることを確認。
- **I2（デプロイ・ユーザー作業含む）**: `wrangler deploy`、D1 作成 + migrations、
  secrets 投入、Cloudflare Access 設定、Ubuntu Server への collector 配置 + timer 有効化。
- **フェーズ6（後続）**: instagram_graph.py（managed アカの真 Insights）、
  Discord/LINE チャネル実装、IG フォールバック手段2/3の実装強化。

---

## 9. 検証・受け入れ基準（最終）

- [ ] 初期5アカウントで 1日3回、systemd timer により無人で D1 が更新される。
- [ ] ダッシュボードでフォロワー推移（グラフ+表）と投稿ごとの公開指標が閲覧できる。
- [ ] 取得失敗・急変動・鮮度切れが events に記録され、ダッシュボードと
      `GET /api/events`（Bearer）の両方から見える。
- [ ] 別のダッシュボードが `READ_API_TOKEN` だけで series/posts/events を取得できる。
- [ ] アカウントの追加・無効化・managed 切替がダッシュボードの管理パネルで完結する。
- [ ] YouTube アカウントを追加するとコード変更なしで系列が出る。
- [ ] 自宅 SQLite に生データが残り、resync スクリプトで D1 を再構築できる。
- [ ] 秘密情報がリポジトリに含まれない。

---

## 10. リスク・注意

- **Instagram 規約**: 自動収集は規約に抵触しうる。公開数値の閲覧目的・低頻度・
  非ログイン主体に留める。セッション使用時は捨てアカ限定。真の Insights は
  必ず公式 Graph API（管理アカのみ）で取る。
- **いいね数の欠損**: 非表示設定の投稿は likes が取れない。NULL 許容で設計済み。
- **仕様変更前提**: パースはテストで守り、フォールバック+イベントで「壊れたら気づく」。
  壊れても粘って IP を焼かない（全滅即中断）。
- **YouTube 丸め**: 登録者数は概数。推移用途では可。
- **法令**: 収集は公開情報の数値のみ。個人データの深掘りはしない。

---

## 11. 環境変数一覧（`.env.example` の元）

collector 側:
```
WORKERS_BASE_URL=https://<your-worker>.workers.dev
INGEST_SECRET=<Workersと共有する乱数>
YOUTUBE_API_KEY=            # 任意
IG_SESSIONID=               # 任意・捨てアカ専用
LOCAL_DB_PATH=/data/local.sqlite
COLLECTOR_LOG_LEVEL=INFO
```
worker 側 (secret): `INGEST_SECRET`, `READ_API_TOKEN`

---

## 12. 未確定 TODO（ブロッカーではない）

- 5アカウントのうち**どれが「管理アカ」か**（フェーズ6の Graph API 対象）→ ユーザー確認待ち。
- LINE 通知の宛先方式（個人 push か LINE Notify 代替か）→ フェーズ6で確定。
- 外部ダッシュボードの CORS 許可オリジン → 利用時に settings へ。
