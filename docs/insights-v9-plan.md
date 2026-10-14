# sns-follower-tracker v9: オーディエンス表示・レポート導線・Workers AI修理・高度分析

## Context

PR #1(P2-P4)マージ・本番デプロイ後のフォローアップ。ユーザーの指摘4点:

1. **オーディエンスが表示されない** — 原因確定: ダッシュボードの「オーディエンス」タブがv3時代の「準備中」プレースホルダのまま([dashboardHtml.ts:121-129](worker/src/lib/dashboardHtml.ts))。**データはD1に収集済み**(demographics_age 7行 / gender 3行 / city 45行、2026-07-15収集成功)。表示UI・取得APIが未実装なだけ。online_followers はIG APIが空を返し続け0行(§7-1既知)
2. **レポートがダッシュボードから見れない** — サイドバーに `/ui/report` への導線がない
3. **Workers AIが使えない** — Cronは正常稼働(07-15分の日報が朝7:01に自動生成済み)だが **LLM講評だけ失敗**(llm_json=NULL)。モデル `@cf/meta/llama-3.3-70b-instruct-fp8-fast` はアカウントで利用可能と確認済み。現状エラー詳細がどこにも残らない設計のため、可視化込みで修理する
4. **より高度な分析** — ユーザー選択(確認済み): **期間トレンド比較 + コンテンツ分析 + フォロワー成長予測**(AI自由質問は除外)。LLMは**まずWorkers AI修理→品質確認後にHaiku切替を判断**

## 実装(2フェーズ・PR2本に分割)

### Phase A — 不具合解消3点(先行PR、即価値)

#### A-1. オーディエンス表示

- `worker/src/lib/analytics.ts` に `getAudienceStats(db, accountId)` を追加: kind ごとに最新 collected_at のバケット群を返す(`{kinds: {demographics_age: [{bucket,value}], ...}, collected_at}`)
- `worker/src/routes/ui.ts` に `GET /ui/audience?account_id=`、`worker/src/routes/insights.ts` に `GET /api/audience`(Bearer+既存 `cacheResponse(300)` の配下)を追加 — 既存の `/ui/summary` ⇔ `/api/summary` ミラー流儀([ui.ts:57](worker/src/routes/ui.ts#L57))を踏襲
- `worker/src/lib/dashboardHtml.ts` のオーディエンスビューを実装: 年齢バー(手書きSVG・既存チャート流儀)、性別バー、都市トップ10表、収集日キャプション。online_followers はデータがある時だけ時間帯ヒートマップ、無い時は「Instagramからまだ提供されていません」注記。**非managedアカウント選択時は従来のプレースホルダ文言を維持**
- `worker/src/lib/reportHtml.ts` + `lib/reports.ts`: 週報・月報の metrics_json に `audience` を追加し、属性セクションを描画(計画書 §5-7 の積み残し)
- online_followers 0行問題: 実装時に collector-host の実トークンで別パラメータを再疎通(読み取りのみ)。取れなければ現状の防御(非表示)のまま

#### A-2. レポート導線

- `dashboardHtml.ts` のサイドバーnavに「レポート」リンク(`<a href="/ui/report">`、モニターモードと同様の外部遷移。アイコンは既存 `icon()` に追加)

#### A-3. Workers AI 修理

- **診断**(実装フェーズ冒頭): `wrangler tail` を接続した状態で本番 `POST /api/reports/daily/2026-07-15/regenerate` を実行し、`console.error` の実物を観測して根本原因を確定
- **原因が何であれ入れる恒久対策**:
  - `lib/reports.ts` の LLM catch で `emitEvent(type='llm_fail', message=エラー詳細)` — 以後の失敗はダッシュボードのイベントに出る(スキーマ変更不要)
  - ~~`lib/llm.ts` WorkersAiProvider に `response_format: json_schema` を試行~~ → **実装時に不採用**: 診断の結果、失敗原因はJSON品質ではなくレスポンス形状(OpenAI互換 `choices[0].message.content` を読んでいなかった)であり、形状対応のみで安定して有効なJSONが得られたため(YAGNI)
  - `selectProvider` で `env.AI` 未定義時に明示メッセージで throw(束縛欠落を即特定できるように)
- 修理後: 本番 regenerate で日本語講評を実生成し、品質(数値誤りなし・平易さ)をユーザーに提示 → Haiku切替の要否を判断してもらう

### Phase B — 高度分析3種(後続PR)

#### B-1. 期間トレンド比較

- `lib/reports.ts`: metrics_json に `compare`(前期間の同KPIと増減率。daily=前日、weekly=前週、monthly=前月)と `trend`(直近12期間のフォロワー終値・純増系列)を追加
- `reportHtml.ts`: KPIタイルに「前期間比 +X%」サブ表示、週報・月報に純増スパークライン+成長率推移

#### B-2. コンテンツ分析

- **migration 0009**: `ALTER TABLE posts ADD COLUMN theme TEXT`(nullable)
- テーマ分類: レポートCron内で `theme IS NULL` の直近90日投稿(最大20件/回)を LLM で一括分類(固定候補: 行事/お知らせ/活動報告/日常/その他)。LLM失敗時は未分類のまま翌日再試行 — A-3 の修理に依存
- ハッシュタグ・キャプション長: `caption_full` からオンザフライ抽出(列追加不要)
- `lib/reports.ts` cross に `by_theme` / `by_hashtag`(top10) / `by_caption_length`(短<100/中/長>300)を追加、週報・月報に「コンテンツ別パフォーマンス」セクション

#### B-3. フォロワー成長予測

- `lib/reports.ts`(または小さな `lib/forecast.ts`): 直近30日の日次終値の線形回帰 → 日次増加ペース・月末予測・目標到達予測日。metrics_json に `forecast`
- 目標人数は settings テーブル(key `follower_goal`)。ダッシュボード設定ビューに入力欄を追加(既存 settings CRUD 流儀)。未設定時は目標関連を非表示
- 表示: 週報・月報 + 日報KPI下に1行(「この調子なら月末◯人」)

## 変更ファイル一覧(主要)

| ファイル | Phase | 内容 |
|---|---|---|
| worker/src/lib/analytics.ts | A | getAudienceStats |
| worker/src/routes/ui.ts / insights.ts | A | /audience ミラー2本 |
| worker/src/lib/dashboardHtml.ts | A | audienceビュー実装 + レポート導線 |
| worker/src/lib/llm.ts | A | json_schema試行 + AI未定義ガード |
| worker/src/lib/reports.ts | A+B | audience注入(A)、compare/trend/cross拡張/forecast(B)、llm_failイベント(A) |
| worker/src/lib/reportHtml.ts | A+B | 属性セクション(A)、比較/トレンド/コンテンツ/予測セクション(B) |
| worker/migrations/0009_post_theme.sql | B | posts.theme |
| worker/src/cron.ts | B | テーマ分類の組み込み |

collector・deploy/systemd は変更なし。

## 検証

- **ローカル**: fixture(audience_stats・theme・複数期間スナップショット)を投入した wrangler dev で、①audienceタブ描画 ②レポート新セクション(compare/trend/コンテンツ/予測/属性) ③regenerate→metrics_json 新キーの値を手計算照合。tsc / pytest(70件維持)。puppeteer スクショ(通常/印刷/390px)
- **本番(マージ後)**: `wrangler tail` + regenerate で **LLM講評の実物を確認**(A-3の完了条件)。audienceタブ・レポート導線・X-Cache を実測。llm_fail イベントが出ないこと
- **フロー**: featureブランチ → Phase A の PR → レビュー・マージ(CI自動デプロイ)→ 本番実測 → Phase B の PR(規約: PR経由・pushはこの計画の承認をもって指示とみなす)

## 備考

- Workers AI の講評品質が確認できたら、その実物をユーザーに見せて Haiku 切替(ANTHROPIC_API_KEY 登録)を判断してもらう(合意済みの進め方)
- online_followers が今後も空なら、ダッシュボードの推奨投稿時間帯は投稿実績ベース(既存cross)のみで運用
