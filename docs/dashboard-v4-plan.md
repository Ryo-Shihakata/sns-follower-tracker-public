# v4: Kumo UI + PWA + 投稿content + 全アカ概要 + アカ全編集 実装記録

最終更新: 2026-07-06 / 親: [dashboard-v3-plan.md](dashboard-v3-plan.md)

ユーザー要望(2026-07-06)への対応。稼働中システムへの機能追加。実装済み・本番反映。

## 要望と対応

| 要望 | 対応 | 主な変更 |
|---|---|---|
| font: Noto Sans JP | Google Fonts で読込、SW がオフラインキャッシュ | `theme.ts`(headMeta 内 font links) |
| UI: cloudflare/kumo | **デザイン言語の移植**(React ライブラリ化はしない)。Kumo の実トークン(orange `#f6821f` ブランド / blue interactive / oklch neutral / canvas-elevated-base サーフェス / emerald-red-yellow semantic)を CSS 変数化。Phosphor 風インライン SVG アイコン | `theme.ts`(KUMO_TOKENS/KUMO_BASE/icon) |
| logo(temp の png/svg) | `worker/public/icons/` に配置、サイドバー/モニター/ファビコン/PWA アイコンに使用 | 生成: 192/512/apple-touch/favicon |
| アカウント管理で全項目編集 | handle・表示名・active・managed をインライン編集 + 保存 + 削除(子データ cascade) | `accounts.ts`(handle/deleteAccount), `ui.ts`(PATCH handle/DELETE), dashboard 管理テーブル |
| 概要のアカウント変更に「全アカウント」全体概要 | アカウント選択に「全アカウント」を追加。全 active アカウントの現フォロワー・前日比・期間純増・スパークライン一覧 + アカウント別純増バー | `analytics.getOverview`, `/ui/overview` `/api/overview`, dashboard overview-all |
| PWA(iOS 含め完全対応) | Workers Static Assets + manifest.webmanifest + sw.js(shell/runtime cache) + iOS メタ(apple-touch/status-bar/capable)+ theme-color + safe-area | `public/`, `wrangler.jsonc` assets, `theme.ts` headMeta/SW_REGISTER |
| appname: SCTracker | タイトル/manifest/ブランド/apple-title に反映 | 全体 |
| 投稿別分析: 実 content 表示・崩れない | collector が thumbnail_url + caption_full を取得 → ingest が upsert で最新化 → worker `/img/:post_id` がサーバー側プロキシ配信(失効/失敗はプレースホルダ)→ 固定サイズサムネ + 2行クランプで崩れない | migration 0003, `queries.ts`, `ingest.ts`, `routes/img.ts`, collector(instagram/instagram_graph/models/main) |

## 検証(2026-07-06、ローカル wrangler dev + 実データ投入)

- worker `tsc --noEmit` PASS / collector `pytest` 29 PASS
- スクリーンショットで目視確認: 概要(単一)・全アカウント概要・投稿別分析(実サムネ画像がプロキシ表示・キャプション全文・reach/saved)・設定 CRUD・モニター(ロゴ/ダーク)
- PWA アセット配信: `/manifest.webmanifest` `/sw.js` `/icons/*` すべて 200
- `/img/:post_id` プロキシが実画像(image/jpeg)を返すことを確認
- バグ修正: `#overview-*` の ID セレクタ `display:flex` が `.hidden` を上書きしていた → `#overview-*.hidden { display:none }` を追加

## 未検証・注意

- iOS 実機でのホーム画面追加/スタンドアロン表示は未検証(メタ・manifest・SW は標準構成)。
- 実 Instagram サムネ(fbcdn 署名 URL)の失効挙動は本番の実データで経過観察。失効時はプレースホルダにフォールバックし崩れない。
- Graph API のサムネ/caption は実トークン未発行のため fixture のみで検証。
