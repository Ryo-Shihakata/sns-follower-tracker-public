# insights-reports-plan v1 — 投稿要因分析 + 日次/週次/月次レポート

作成: 2026-07-12。対象: managed アカウント(現状 example_account)の「伸びた要因」分析と定期レポート生成。

## §1 決定事項(ユーザー合意済み・再解釈禁止)

| 論点 | 決定 |
|------|------|
| 分析の主眼 | フォロワー増加への投稿別寄与 と 投稿エンゲージメント要因 の両方 |
| 手法 | 数値分析(決定的メトリクス)+ LLM講評 |
| LLM | **Workers AI で開始、プロバイダ抽象化で将来 Claude Haiku に切替可能にする** |
| レポート種別 | 日報 + **週報(月曜)+ 月報(毎月1日)** |
| 閲覧 | ダッシュボード内レポートページ + **印刷CSS方式のPDF出力** |
| 生成タイミング | 毎朝 7:00 JST(= 22:00 UTC の Cron Trigger)に前日/前週/前月分 |
| 収集頻度 | **managed のみ毎時収集**(他アカウントは現状の1日3回のまま) |
| 同時実装 | トークン自動refresh / 急伸急落アラート / フォロワー属性収集 / online_followers収集 |
| 想定読者 | **生徒会メンバーと共有**(平易な日本語、報告資料として使える体裁) |
| 日報スコープ | managed 深掘り + 末尾に他アカウント増減1行サマリ表 |
| LLM講評の構成 | 総評(2-3文)/ 伸びた・落ちた要因(箇条書き)/ 次のアクション提案(1-3件)の3セクション。**数値はテンプレート側で確定表示し、LLMは解釈のみ担当**(ハルシネーション対策) |

## §2 データ収集の拡張(collector)

### 2.1 追加メトリクス(Graph API / Instagram Login `graph.instagram.com/v25.0`)

- **投稿別**(media insights に追加):
  - FEED系(image/carousel): `follows`(その投稿経由の新規フォロー)・`profile_visits`・`shares`・`total_interactions`
  - REELS(video): `shares`・`total_interactions`・`ig_reels_avg_watch_time`・`ig_reels_video_view_total_time`(follows/profile_visits はリール非対応の可能性 → 防御的取得)
- **アカウント日次**(account insights に追加): `follows_and_unfollows`(増減内訳)・`accounts_engaged`・`total_interactions`
- **online_followers**: フォロワーのオンライン時間帯(lifetime期間)。1日1回取得で十分
- **フォロワー属性**(週1回): `follower_demographics`(age/gender/city/country、`metric_type=total_value&breakdown=...`)。フォロワー100人未満だと取れない

既存の防御的取得パターン(欠損しても投稿全体を失敗にしない、メトリクスセットのフォールバック)を踏襲する。

### 2.2 毎時収集(managed のみ)

- collector-host に `collector-graph.timer`(`OnCalendar=*-*-* *:45:00` 毎時)+ 対応する service を追加。既存 `collector.timer`(1日3回、全アカウント)はそのまま
- collector に `--graph-only` フラグ(または env `COLLECT_MODE=graph`)を追加し、managed かつ graph 選択のアカウントだけを回す
- **毎時実行での投稿絞り込み**: insights取得は「直近12件 + posted_at が7日以内の投稿」に限定(古い投稿は1日3回の既存実行でカバー)。API レートは 200 calls/hour/user に対し毎時 ~15-30 calls で余裕
- demographics / online_followers は毎時実行に含めない(§2.1 の頻度で別途)

### 2.3 スキーマ(migration 0008)

```sql
-- post_snapshots に追加
ALTER TABLE post_snapshots ADD COLUMN follows INTEGER;
ALTER TABLE post_snapshots ADD COLUMN profile_visits INTEGER;
ALTER TABLE post_snapshots ADD COLUMN shares INTEGER;
ALTER TABLE post_snapshots ADD COLUMN total_interactions INTEGER;
ALTER TABLE post_snapshots ADD COLUMN avg_watch_time_ms INTEGER;   -- reels
ALTER TABLE post_snapshots ADD COLUMN total_watch_time_ms INTEGER; -- reels

-- snapshots に追加(アカウント日次)
ALTER TABLE snapshots ADD COLUMN follows_gained INTEGER;
ALTER TABLE snapshots ADD COLUMN follows_lost INTEGER;
ALTER TABLE snapshots ADD COLUMN accounts_engaged INTEGER;
ALTER TABLE snapshots ADD COLUMN total_interactions INTEGER;

-- 属性・オンライン時間帯(汎用 key-value、週次/日次で上書きせず履歴保持)
CREATE TABLE audience_stats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  kind         TEXT NOT NULL,        -- 'demographics_age' | 'demographics_gender' | 'demographics_city' | 'online_followers'
  bucket       TEXT NOT NULL,        -- '13-17' | 'F' | 'Fukuoka' | '0'..'23'(時間帯)
  value        INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE (account_id, kind, bucket, collected_at)
);

-- レポート本体
CREATE TABLE reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,        -- 'daily' | 'weekly' | 'monthly'
  period_start TEXT NOT NULL,        -- JST暦日 'YYYY-MM-DD'
  period_end   TEXT NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  metrics_json TEXT NOT NULL,        -- 集計済み数値(確定値)
  llm_json     TEXT,                 -- {summary, factors[], actions[], model, generated_at}
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, period_start, account_id)
);
```

### 2.4 トークン自動refresh

- collector のローカル store(SQLite)に `token`, `expires_at` を保持。初回は .env の値をシードにする
- 毎実行時に残り日数を確認し、**残10日以下**で `GET /refresh_access_token?grant_type=ig_refresh_token`(client_secret 不要)を呼び、新トークン+expires_in を store に保存
- refresh 失敗・残3日以下は `token_expiring` イベントを /ingest 経由で events に発報(ダッシュボードに警告表示)
- 注: 発行から24時間未満のトークンは refresh 不可(IG仕様)。失敗時は次回実行で再試行

## §3 要因分析ロジック(数値・worker側で集計)

1. **フォロワー増減の投稿別寄与**: 期間内の各投稿の `follows` 増分を集計しランキング。`follows_and_unfollows` のアカウント値と突き合わせ「投稿由来 vs その他(発見タブ・外部流入等)」を分解
2. **エンゲージメント要因分解**: 投稿ごとに いいね率/保存率/シェア率(各÷リーチ)を算出し、**直近30日の投稿の中央値をベースライン**とした倍率(伸び係数)で表示
3. **初速カーブ**: 毎時データから投稿後 1h/3h/6h/24h/48h 時点の到達値を補間算出し、過去投稿の同時点分布と比較(「この投稿は24h時点で過去中央値の2.1倍」)
4. **クロス集計**: 曜日×時刻×形式(image/carousel/reel)別の平均リーチ・follows。online_followers と重ねて「推奨投稿時間帯」を提示
5. **急伸・急落アラート**(収集直後に評価、events へ):
   - フォロワー日次増減が |Δ| ≥ max(10, 過去30日日次Δの3σ)
   - 投稿の24hリーチがベースライン中央値の3倍以上(急伸)/ 直近3投稿連続でベースラインの0.5倍未満(不調)
   - 閾値は settings テーブルで調整可能にする

## §4 レポート生成(worker)

- **Cron Trigger**: `crons = ["0 22 * * *"]`(= JST 7:00)。ハンドラ内で JST日付を判定し、毎日=日報 / 月曜=+週報 / 1日=+月報 を生成
- パイプライン: SQL集計 → `metrics_json` 確定 → LLM講評 → reports に UPSERT。**LLM失敗時も数値部分だけで保存**(講評は「生成失敗」表示+後述の再生成で復旧)
- **LLMプロバイダ抽象化**:
  ```ts
  interface LlmProvider { generate(system: string, prompt: string): Promise<string> }
  // 実装: WorkersAiProvider(env.AI binding, @cf/meta/llama-3.3-70b-instruct-fp8-fast)
  //       AnthropicProvider(env.ANTHROPIC_API_KEY, claude-haiku-4-5)
  // 選択: env.LLM_PROVIDER('workers-ai' | 'anthropic')。キー未設定時は workers-ai に自動フォールバック
  ```
- プロンプト設計: 確定済み集計値(JSON)+ 投稿キャプション要約を渡し、**JSONモードで {summary, factors[], actions[]} を返させる**。数値の再計算・引用はテンプレート側で行い、LLM出力内の数値はそのまま信用しない(表示は必ず metrics_json 由来)
- 出力言語・トーン: 平易な日本語。読者は生徒会メンバー(非専門家)
- UI から `POST /api/reports/:kind/:date/regenerate`(管理操作)で再生成可能に

## §5 UI(/ui/report)

- 日付・週・月ピッカーと kind タブ。構成(上から):
  1. ヘッダ(SCTracker ロゴ・対象期間・アカウント名)
  2. KPI行(フォロワー・増減・リーチ・ビュー・新規フォロー数)
  3. **総評**(LLM summary)
  4. フォロワー増減の内訳と投稿別寄与ランキング(横棒)
  5. 投稿パフォーマンス表(サムネ・形式・投稿時刻・リーチ・いいね率・保存率・follows・初速倍率)
  6. 推奨投稿時間帯(online_followers ヒートマップ、週報・月報のみ)
  7. フォロワー属性(週報・月報のみ)
  8. 他アカウント増減サマリ表(1行×12アカウント)
  9. 要因と提案(LLM factors / actions)
- **印刷CSS**: `@media print` で A4縦・改ページ制御(`break-inside: avoid`)・サイドバー等のUI要素非表示・脚注(指標の用語説明)。画面上に「PDFとして保存」ボタン(`window.print()`)
- 既存の手書きSVGチャート・Kumoデザイン言語・Noto Sans JP を踏襲(外部CDN不可)

## §5.5 Workers Cache(Cache API)

読み取り系エンドポイントに `caches.default` を組み込み、D1クエリ回数と応答時間を削減する。

| 対象 | TTL | 方針 |
|------|-----|------|
| `GET /api/reports/:kind/:date` | 過去期間=86400s / 当日分=300s | 生成済みレポートは実質不変。`regenerate` 時は `cache.delete()` で明示パージ |
| `GET /api/overview` `/api/series/*` 等の集計API | 300s | 収集は毎時なので5分で十分新鮮 |
| `GET /img/:post_id`(サムネプロキシ) | 604800s(7日) | 失効時プレースホルダは短TTL(3600s) |
| `/ui/*` 静的HTML | キャッシュしない | 認証・更新頻度の観点でそのまま |

- キャッシュキーは URL ベース。認証付きAPIは **認証検証を通過した後に** キャッシュ参照/保存する(`Authorization` ヘッダをキーに含めない。トークンは全読者共通のため衝突リスクなし)
- レスポンスに `X-Cache: HIT|MISS` を付与しデバッグ可能にする
- `/ingest` 書込後のパージは行わない(TTL 300s の自然失効で十分。パージ対象URLの列挙が複雑になるため)

## §6 実装フェーズ

| フェーズ | 内容 | 完了条件 |
|---------|------|---------|
| P1 | migration 0008 / collector 追加メトリクス / 毎時timer / トークンrefresh | 実トークンで新メトリクス取得をライブ確認、毎時データがD1に到達 |
| P2 | 集計ロジック / reports テーブル / Cron Trigger / Workers AI講評 / Workers Cache(§5.5) | 日報が毎朝自動生成され API で取得可能、X-Cache HIT を確認 |
| P3 | /ui/report + 印刷CSS + アラート | 画面スクショ + 印刷プレビューA4確認、アラートevents発報テスト |
| P4 | 週報・月報 / demographics / online_followers | 週報・月報の実生成確認 |

## §7 要検証(P1着手時に最初に潰す)

1. ~~Instagram Login API で取れるメトリクスの実確認~~ → **検証済(2026-07-12 実トークンで疎通)**:
   - ✅ フィード投稿の `follows` / `profile_visits` / `shares` / `total_interactions`(値取得成功)
   - ✅ リールの `shares` / `total_interactions` / `ig_reels_avg_watch_time` / `ig_reels_video_view_total_time`
   - ❌ リールの `follows` / `profile_visits` は非対応(APIがエラーを返すことを確認)→ media type でメトリクスセット分岐
   - ✅ アカウント `accounts_engaged` / `total_interactions`(period=day, total_value)
   - △ `follows_and_unfollows` は0件の日は `total_value.breakdowns[].results` が欠落 → 0として防御的パース
   - ✅ `follower_demographics`(breakdown=age で構造確認)
   - △ `online_followers` は values が空 `{}`(データ蓄積待ちの可能性)→ 防御的パース、空なら UI 非表示、P4 で再評価
2. ~~example_account のフォロワー数が100以上か~~ → **解決済(2026-07-12 ユーザー確認: 100以上)**
3. Workers AI の日本語講評品質(数件生成して確認、不足なら早期に Haiku 切替)
4. 毎時収集による D1 行数増加(概算: 30投稿×24回/日 ≈ 720行/日、年26万行。問題ない規模だが、チャートAPIのクエリに `collected_at` インデックス追加を検討)

## §8 採用した前提(質問済み事項以外)

- 毎時収集の cron 分は `:45`(既存の3回/日と衝突しない分を選ぶ。RandomizedDelay は付けず初速カーブの等間隔性を優先)
- 日報の集計期間は JST 0:00-24:00 の暦日(既存 GAS エクスポートは UTC 暦日のまま変更しない)
- レポートは managed アカウントごとに1本(将来 managed が増えたら自動的に複数生成)
- アラート評価は worker /ingest 受信時にインライン実行(別cron不要)
