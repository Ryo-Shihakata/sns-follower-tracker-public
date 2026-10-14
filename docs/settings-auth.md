# 設定の権限管理(暫定パスワード方式)

v11 で追加。ダッシュボードの「設定」ビュー(アカウント管理・フォロワー目標)を
Cloudflare secret のパスワードで保護する。**将来 Google OAuth へ移行する前提の暫定実装。**

## 仕組み

- secret `SETTINGS_PASSWORD` が**未設定なら従来どおり全開放**(オプトイン)
- 設定ビューを開くと `GET /ui/auth/status` で認証状態を確認し、未認証ならパスワード入力を表示
- `POST /ui/auth/login` でパスワード照合(定数時間比較)。成功すると
  HMAC-SHA256 署名付きセッション cookie(`fjsc_settings_auth`、30日、HttpOnly/Secure/SameSite=Lax)を発行
- 書込系エンドポイントは cookie 検証必須:
  - `PUT /ui/app-settings`
  - `POST/PATCH/DELETE /ui/accounts`
  - (イベント既読化・閲覧系は対象外)
- cookie 失効後に保存しようとすると 401 → UI が自動でロック画面に戻る

collector や外部 API(`/ingest`, `/api/*`)は従来どおり Bearer 認証で、この仕組みの影響を受けない。

## 有効化手順

```sh
cd worker
npx wrangler secret put SETTINGS_PASSWORD   # 任意のパスワードを入力
```

ローカル開発では `worker/.dev.vars` に `SETTINGS_PASSWORD=...` を書く(未記載なら開放)。

## Google OAuth への移行メモ

実装は `worker/src/lib/uiAuth.ts` に集約してあり、次の2層に分かれている:

1. **セッション層**(cookie の発行 `issueSessionCookie` / 検証 `requireSettingsAuth`) — OAuth 移行後もそのまま使う
2. **credential 層**(`handleLogin` = パスワード照合) — 移行時はここを Google OAuth の
   コールバック(認可コード交換 → メールアドレスが許可リストにあれば `issueSessionCookie`)に差し替える

移行時の追加作業: Google Cloud Console で OAuth クライアント作成 →
`GET /ui/auth/google`(リダイレクト)と `GET /ui/auth/callback` を追加 →
許可メールアドレスを secret か settings に持つ → ロック画面のフォームを「Googleでログイン」ボタンに変更。
