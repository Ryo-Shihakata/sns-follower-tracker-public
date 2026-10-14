# ダッシュボード刷新 + モニターモード + Graph API 実装計画 (v3)

最終更新: 2026-07-05 / 対象実装者: coding agent
親計画: [implementation-plan.md](implementation-plan.md)(§番号はこれを指す)

このドキュメントは、既にデプロイ済みの本番システム(worker + collector、実データ取得中)に
対する**機能追加**の計画である。参考にした UI 画像(Instagram フォロワー推移ダッシュボード)の
レイアウト・情報設計を踏襲しつつ、**このシステムで実際に取得できるデータ**で構成する。

---

## 0. 追加要件(ユーザー指示)

1. **いいね数もグラフで見られるようにする**(現状は投稿ビューのスパークラインのみ)。
2. **モニターモード**を新設。大きく一目で見える表示:
   - 現在のフォロワー数(特大)
   - 最新3件の投稿のいいね数
   - 前日比のフォロワー増減(推移)
3. **ダッシュボードのデザイン刷新**。参考画像に沿ってわかりやすく(左サイドバー、KPI カード、
   期間切替つき推移グラフ、増減バーチャート等)。
4. **Instagram Graph API 実装**(管理アカウント `example_account` の真の Insights)。

---

## 1. データの現実(重要 — 設計の前提)

参考画像には「新規フォロー/フォロー解除の内訳」「性別・年齢の属性サマリー」があるが、
**これらは公開スクレイピングでは取得できない**。正直な対応方針:

| 参考画像の要素 | このシステムでの扱い |
|---|---|
| フォロワー総数 | ✅ `snapshots.followers` の最新値 |
| 前日比(+132 +1.04%) | ✅ 最新と約24h前の snapshot 差分で算出 |
| 期間純増数 | ✅ 期間の始点と終点の差分 |
| フォロワー推移(日次/週次/月次) | ✅ snapshots 時系列。週次/月次は集約(ダウンサンプル) |
| フォロワー増減数の推移(バー) | △ **純増減の単系列**バーとして表示可(緑=増/橙=減)。「新規/解除」への分解は**不可** |
| 新規フォロー vs フォロー解除の内訳(ドーナツ) | ❌ 公開データでは不可 → **いいね推移グラフ**にパネルを転用 |
| 性別・年齢の属性サマリー | ❌ 公開では不可。**`example_account` のみ** Graph API の `audience_gender_age` で将来取得可(本 v3 ではスキーマ追加を伴うため**後続**、パネルは「Graph API 連携後に有効化」表示) |
| いいね・コメント・再生数 | ✅ `post_snapshots`(全アカウント公開値) |
| リーチ・インプレッション・保存数 | ✅ `example_account` のみ Graph API で(`post_snapshots.reach/impressions/saved` に既存列あり) |

**結論**: 参考画像の**見た目・情報密度・カード構成は踏襲**しつつ、取れないカードは
取れる指標(平均いいね・投稿数・エンゲージメント等)に差し替える。属性サマリーだけは
`example_account` 向け後続機能として枠を用意する。

---

## 2. 全体設計

### 2.1 画面構成(worker が配信する SPA 風 HTML。外部 CDN 不可 → 全インライン)

```
┌────────────┬───────────────────────────────────────────────────────────┐
│ サイドバー │  ヘッダー: [アカウント選択▼]  [期間: 30日▼]  [モニターモード↗]│
│            ├───────────────────────────────────────────────────────────┤
│ 概要       │  KPIカード×4 (各: 数値 + 前日比/期間比バッジ + スパークライン)│
│ フォロワー │   ①フォロワー総数 ②前日比増減 ③期間純増 ④直近投稿の平均いいね│
│  推移      ├──────────────────────────────┬────────────────────────────┤
│ いいね推移 │  フォロワー推移(面グラフ)     │  いいね数の推移(折れ線)   │
│ 投稿別分析 │  [日次/週次/月次] 切替         │  最新投稿群のいいね時系列   │
│ オーディ   ├──────────────────────────────┴────────────────────────────┤
│  エンス(準)│  フォロワー増減数の推移(バー: 緑=増/橙=減、日次)          │
│ 設定       ├───────────────────────────────────────────────────────────┤
│ イベント   │  投稿別分析(最新投稿カード: サムネなし・いいね/コメント/再生 │
│            │   + example_account は reach/saved も)                          │
└────────────┴───────────────────────────────────────────────────────────┘
```

- **アカウント選択**: 5アカウントを切替。既存は全アカ重ね描きだったが、参考画像に合わせ
  「1アカウント集中ビュー + 任意で比較」に。デフォルトは `example_account`。
- 既存の**アカウント管理パネル**(追加/active/managed 切替)は「設定」セクションへ移動。
- 既存の**イベントパネル**は「イベント」セクションへ。
- 配色・トーン: 参考画像準拠(フォロワー=ピンク/マゼンタ系、増=緑、減=橙、純増=紫)。
  ライト/ダーク両対応。**チャートは dataviz スキルの方法に従って実装する**。

### 2.2 モニターモード(別ルート `GET /monitor`)

全画面・大型表示・自動更新(既定5分)。壁掛けモニタ/常時表示を想定。

```
┌───────────────────────────────────────────────────────────────┐
│  @example_account                              2026-07-05 21:15 更新│
│                                                               │
│     現在のフォロワー数                                        │
│        12,842            ▲ +132  (+1.04%)  前日比             │
│     ────────────────────────────────  ← 直近フォロワーの小さな推移線│
│                                                               │
│   最新の投稿                                                  │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐                       │
│   │ いいね   │  │ いいね   │  │ いいね   │                      │
│   │  321    │  │  289    │  │  256    │                       │
│   │ 7/1投稿 │  │ 6/28投稿│  │ 6/25投稿│                        │
│   └─────────┘  └─────────┘  └─────────┘                       │
└───────────────────────────────────────────────────────────────┘
```

- クエリ `?account_id=`(既定 example_account)。`?rotate=1` で全アカウントを一定間隔で巡回。
- 数値は特大フォント、コントラスト高め、ダーク基調(モニタ表示向き)。
- 前日比が + なら緑▲、− なら橙▼。
- meta refresh または JS setInterval で自動更新(READ_API_TOKEN は埋め込まず、後述の
  `/monitor` は Cloudflare Access 配下・同一オリジンの内部 API から取得)。

### 2.3 いいね数グラフ

- 「いいね推移」セクション: 選択アカウントの**最新 N 投稿**それぞれの `post_snapshots.likes`
  時系列を折れ線で重ね描き(凡例=投稿の日付/shortcode)。
- 併せて概要ページの右パネルにも簡易版(直近投稿の合計いいね推移)を置く。

---

## 3. API 追加・変更(worker/)

新規レスポンスはすべて既存同様キーでラップ。認証は読取系=`READ_API_TOKEN`、
ただし**ダッシュボード/モニターの UI 内部呼び出しは `/ui/*` 同一オリジン**(§5.5 の方針を踏襲、
本番は Cloudflare Access で保護)。

| メソッド | パス | 認証 | 役割 |
|---|---|---|---|
| GET | `/api/summary?account_id=&from=&to=` | READ_API_TOKEN | KPI 一式(現フォロワー・前日比・期間純増・平均いいね等)を1回で返す |
| GET | `/api/followers/diff?account_id=&from=&to=&bucket=day\|week\|month` | READ_API_TOKEN | 期間バケットごとの純増減(バーチャート用) |
| GET | `/api/likes/series?account_id=&limit=` | READ_API_TOKEN | 最新 limit 投稿の likes 時系列(いいねグラフ用) |
| GET | `/api/monitor?account_id=` | READ_API_TOKEN | モニターモード用: 現フォロワー・前日比・最新3投稿のいいね |
| GET | `/monitor` | (UI/Access) | モニターモード HTML |
| GET | `/ui/summary` `/ui/followers/diff` `/ui/likes/series` `/ui/monitor` | (UI/Access) | 上記の同一オリジン版(トークン非埋込) |

- 既存 `/api/series` は `bucket` パラメータ対応に拡張(日次/週次/月次)。集約は
  各バケットの**最終値**(フォロワーは累積量なので終値が正しい)。
- 前日比の「前日」= 最新 snapshot から約24h前に最も近い snapshot(厳密な同時刻でなくてよい)。

---

## 4. Graph API 実装(collector/、親計画 §5.3)

### 4.1 目的とスコープ
`accounts.managed=1`(= `example_account` のみ)について、公式 **Instagram Graph API** で
真の Insights を取得し、既存の ingest 経路で送る。**公開スクレイピングの置き換えではなく、
managed アカに対してのみ Graph 版 collector を優先**し、トークン未設定時は既存 web collector に
フォールバック(=壊れない)。

### 4.2 取得内容(本 v3 のスコープ)
- アカウント: `followers_count`, `media_count`(→ snapshots.followers/posts)
- 最新メディア: `id, permalink, timestamp, media_type, caption, like_count, comments_count`
  (→ posts / post_snapshots.likes/comments)
- メディア Insights: `reach, saved`(動画は `views`/`plays` も)
  (→ post_snapshots.reach/impressions/saved。**既存列にそのまま入る**ので worker 側変更不要)
- **オーディエンス属性(gender/age)は本 v3 では対象外**(新スキーマが必要なため後続)。

### 4.3 実装
- `collector/src/collector/platforms/instagram_graph.py`: `Collector` 実装。
  - Graph API のベース URL・バージョンは定数。`GET {ig_user_id}?fields=...`、
    `{ig_user_id}/media?fields=...`、`{media_id}/insights?metric=reach,saved`。
  - `source="ig-graph"` を付与。
- **トークン/ID の設定**: `IG_GRAPH_TOKEN`(長期トークン)と `IG_GRAPH_USER_ID`(example_account の
  IG Business User ID)を環境変数で。将来複数管理アカに拡張できるよう、
  `config.py` で `{handle: {token, ig_user_id}}` のマップを組めるようにする
  (当面は単一。`IG_GRAPH_TOKEN` / `IG_GRAPH_USER_ID` を example_account に紐付け)。
- **registry/main の分岐**: `build_collectors` で managed かつ Graph 設定ありのアカウントには
  graph collector を、それ以外(および未設定 managed)には既存 web collector を割り当てる。
  この判定に必要な `managed` フラグは `/accounts` レスポンスに含まれている(既存)。
- パースは**固定フィクスチャのユニットテスト必須**(Graph API の現実的なサンプル JSON を自作)。

### 4.4 外部前提(ユーザー作業。コードはこれ抜きでも動く形にする)
Graph API を**実際に動かす**には次が必要(コード実装とは別レイヤ):
1. `example_account` が **ビジネス/クリエイターアカウント**であること + Facebook ページ連携。
2. **Meta アプリ**作成、`instagram_basic` + `instagram_manage_insights` 権限、
   **長期アクセストークン**の発行、IG Business User ID の取得。
3. `IG_GRAPH_TOKEN` / `IG_GRAPH_USER_ID` をサーバーの `.env` に設定。
→ これらが未設定の間は web collector で従来どおり動作。手順は実装時に
`collector/docs/graph-api-setup.md` として残す。

---

## 5. 実装トラック(並列。ファイル集合は互いに素)

### トラック D(worker/ のみ — ダッシュボード刷新 + いいね + モニター)
- 新 API(§3)、`/api/series` の bucket 拡張。
- ダッシュボード HTML 全面刷新(§2.1、参考画像準拠、dataviz スキル準拠)。
- モニターモード(§2.2)。
- 既存機能(管理パネル・イベント)はセクション移設で維持。
- **スキーマ変更なし**(既存テーブルで足りる)。migrations は追加しない。
- 完了条件: `wrangler dev` + ローカル D1 にダミー投入し、各 API が 200/JSON、
  ダッシュボード各セクションとモニターモードが描画される(curl で HTML/JSON 検証。
  可能ならスクリーンショット)。`npx tsc --noEmit` 通過。

### トラック G(collector/ のみ — Graph API)
- `instagram_graph.py`、`config.py`/`registry.py`/`main.py` の Graph 分岐、
  フィクスチャ・ユニットテスト、`collector/docs/graph-api-setup.md`。
- **既存 web collector・store・client は壊さない**(managed 未設定時のフォールバック維持)。
- 完了条件: `uv run pytest` 全 green(既存 + Graph 新規)。トークン未設定時に
  従来の web collector が選択されることを確認するテスト。実 Graph API アクセスは
  トークンが無いため**未検証**として報告(フィクスチャで代替)。

**契約(トラック間の境界)**: Graph collector が送る ingest ペイロードは既存 §5.5 の形。
`reach/saved/impressions` は `recent_posts[].reach` 等の既存フィールドに入れるだけで、
worker 側は既に受理する(ingest.ts の IngestPostInput に定義済み)。→ **worker 変更不要**。

---

## 6. 検証・デプロイ

1. 両トラック完了 → main へマージ → 自分でスポットチェック。
2. 統合検証: `wrangler dev` にダミー投入し、ダッシュボード/モニター/いいねグラフを確認。
   Graph collector はフィクスチャ経路で ingest 疎通のみ確認。
3. デプロイ: `wrangler deploy`(D1 スキーマ変更なしなので migrations 適用は不要)。
   collector はサーバーへ再転送 + イメージ再ビルド。
4. Graph API のトークン設定はユーザー作業(§4.4)。設定後に live 確認。

---

## 7. 未確定・ユーザー確認事項

- KPI カード4枚目の指標(案: 直近投稿の平均いいね)。参考画像の「フォロワー減少数」は
  取得不可のため差し替える。異論あれば差し替え先を指定。
- 属性サマリー(性別/年齢)は example_account 限定・後続(新スキーマ)。本 v3 では枠のみ。
- Graph API の Meta アプリ/トークンの準備状況(未なら web collector のまま運用継続)。
