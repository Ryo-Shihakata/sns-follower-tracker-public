# Instagram API (Instagram Login) セットアップ手順 (example_account)

対象コード: `collector/src/collector/platforms/instagram_graph.py`。
このドキュメントは**ユーザー作業**の手順。コード側はこれが未完了でも壊れない
(`IG_GRAPH_TOKEN` / `IG_GRAPH_USER_ID` が未設定なら `example_account` も含め通常の
web collector にフォールバックする。docs/dashboard-v3-plan.md §4.3, §4.4)。

**2026年方式**: 旧来の「Facebook Login for Business + graph.facebook.com」ではなく、
「**Instagram API with Instagram Login**」(`graph.instagram.com`) を使う。Facebook
ページとの連携が不要になり、短期トークン→長期トークン交換も1ステップに簡略化された。

## 前提

- `example_account` の Instagram アカウントを管理できる Meta アカウントがあること。
- `example_account` がプロアカウント(ビジネスまたはクリエイター)であること。
  Facebook ページとの連携は**不要**。

## 手順

### 1. example_account をプロアカウントにする

1. Instagram アプリで `example_account` にログイン。
2. 設定 → アカウントの種類とツール → 「プロアカウントに切り替える」から
   **ビジネスアカウント**(またはクリエイター)を選択。

### 2. Meta アプリを作成し、Instagram Login を設定する

1. https://developers.facebook.com/apps/ で新規アプリを作成(種類: 「ビジネス」)。
2. アプリダッシュボード → **Instagram** → 「**API setup with Instagram Login**」を開く。
3. 案内に従って対象 Instagram アカウント(`example_account`)を追加する。
4. 必要スコープ:
   - `instagram_business_basic`
   - `instagram_business_manage_insights`

### 3. アクセストークンを直接発行する(短期→長期の交換は不要)

「API setup with Instagram Login」の画面には **Generate Token** ボタンがあり、
これを押すだけで**長期(60日)トークンが直接発行される**。旧方式のような
「短期トークンを `fb_exchange_token` で長期化する」手順は不要になった。

発行されたトークンをそのまま `.env` の `IG_GRAPH_TOKEN` に設定する。

運用上の注意: 長期トークンは無期限ではない(60日で失効)。定期的な更新が必要
(次項参照)。本 v3 では自動更新の仕組みは実装していないため、有効期限切れ前に
手動でリフレッシュするか、失効後は本手順3を再実行して `.env` を更新すること。

### 4. トークンの更新(リフレッシュ)

長期トークンは発行から24時間以上経過し、かつ60日以内であれば、以下のエンドポイントで
**client_secret 不要**でリフレッシュできる:

```
GET https://graph.instagram.com/refresh_access_token
  ?grant_type=ig_refresh_token
  &access_token=<現在の長期トークン>
```

レスポンスの `access_token` が新しい長期トークン(有効期限がさらに60日延長される)。
これで `.env` の `IG_GRAPH_TOKEN` を更新する。

### 5. Instagram User ID の取得

次のいずれかで取得できる:

- Meta アプリダッシュボードの「API setup with Instagram Login」画面に表示されている
  Instagram アカウントの User ID を直接見る。
- または API で取得する:

  ```
  GET https://graph.instagram.com/v25.0/me?fields=user_id&access_token=<トークン>
  ```

取得した ID を `.env` の `IG_GRAPH_USER_ID` に設定する。

### 6. `.env` に設定する

```
IG_GRAPH_TOKEN=<手順3で得た長期トークン>
IG_GRAPH_USER_ID=<手順5で得た Instagram User ID>
```

**app secret は collector では不要**(Instagram API with Instagram Login では
アクセストークンとリフレッシュのみで完結し、client_secret を使う場面がない)。

collector を再起動(または次回 systemd timer 実行)すると、`example_account`
(`accounts.managed=1` のアカウント)だけ自動的に Graph API collector
(`source="ig-graph"`)に切り替わる。他のアカウントは引き続き web collector
(`source="ig-web"`)のまま。

### 7. 別のアカウントにも Graph API を挿入する（複数 managed アカウント）

任意のアカウントを Graph API 化するには、**環境変数を2つ足すだけ**でよい
(コード・スキーマ変更不要。`collector/src/collector/config.py`)。

1. そのアカウントを手順1〜5と同様に連携し、handle 用のトークンと
   Instagram User ID を用意する。
2. ダッシュボードの「設定」でそのアカウントの `managed` を ON にする。
3. `.env` に、対象 handle を列挙し、handle ごとのトークン/IDを設定する。
   環境変数サフィックスは handle を**大文字化し英数字以外を `_` に置換**したもの:

   ```
   # 例: example_account_a と example_account_b を追加
   IG_GRAPH_ACCOUNTS=example_account_a,example_account_b
   IG_GRAPH_TOKEN_EIZOCREATOR_PROJECT=<長期トークン>
   IG_GRAPH_USER_ID_EIZOCREATOR_PROJECT=<Instagram User ID>
   IG_GRAPH_TOKEN_HIGASHIFUKUOKA_SEITOKAI=<長期トークン>
   IG_GRAPH_USER_ID_HIGASHIFUKUOKA_SEITOKAI=<Instagram User ID>
   ```

   レガシーの `IG_GRAPH_TOKEN` / `IG_GRAPH_USER_ID`(サフィックスなし)は引き続き
   `example_account` に紐付く。両方あれば handle 別設定が優先。片方だけの handle は無視。

### アカウントレベルの日次 Insights（スプレッドシート連携用）

Graph collector は投稿別の reach/saved/views に加えて、**アカウント単位の日次
Insights**(`reach` / `views`, `period=day`, `metric_type=total_value`)も取得し、
snapshots に保存する(migration 0004 の reach 列 + migration 0005 の views 列)。
これが GAS スプレッドシート([../../docs/gas-spreadsheet.md](../../docs/gas-spreadsheet.md))
のリーチ/ビューの列の出どころ。

- 必要権限は `instagram_business_manage_insights`(手順2で付与済みなら追加作業なし)。
- **旧メトリクスの対応表**(2025-04-21 に Meta が完全廃止):

  | 旧メトリクス | 状態 | 後継 |
  |---|---|---|
  | リーチ (`reach`) | 継続 | そのまま `reach` |
  | インプレッション (`impressions`) | **廃止** | `views` |
  | プロフィール閲覧 (`profile_views`) | **廃止** | `views` |

- `views` がバージョン/アカウントによっては取得できないことがあり、その場合 collector は
  `reach` のみで再試行し、`views` 列は空欄のままにする(run は失敗させない)。

## 動作確認

`.env` 設定後、以下で疎通確認できる(実アクセスは課金なし、レート制限あり):

```
GET https://graph.instagram.com/v25.0/<IG_GRAPH_USER_ID>?fields=followers_count,media_count&access_token=<IG_GRAPH_TOKEN>
```

200 で `followers_count` が返れば設定は正しい。collector 本体の動作確認は
`uv run pytest tests/test_instagram_graph_parse.py` (フィクスチャによるパース確認、
実 API 不要) と、実運用ランで `source` が `ig-graph` になっていることを
ダッシュボード or `collection_runs` で確認する。

## トラブルシューティング

- `400 Invalid OAuth access token` / `(#190)`: トークン失効(60日ルール)、または
  `graph.facebook.com` 用に発行したトークンを `graph.instagram.com` に対して使っている
  (逆に `graph.instagram.com` 用トークンを `graph.facebook.com` に使った場合も同様に失敗する)。
  本 collector は必ず `graph.instagram.com` を使うため、`.env` のトークンも
  「API setup with Instagram Login」で発行したものであることを確認する。手順3を再実行。
- `(#10) Application does not have permission`: 権限
  (`instagram_business_manage_insights` 等)が未承認。アプリのダッシュボードで
  権限リクエスト状態を確認。
- `insights` が特定メディアだけ空: 投稿から24時間以内など Meta 側の集計反映待ち、
  または対応していないメディア種別(一部の広告連携投稿等)。collector 側は
  insights 取得失敗を握りつぶして `reach`/`saved`/`views` を `None` のまま
  ingest するので、run 自体は失敗にならない。
