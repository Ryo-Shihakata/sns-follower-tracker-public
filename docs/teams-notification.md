# Teams 通知(Power Automate 連携)

毎朝のレポート生成 cron(JST 7:00)後に、Worker が Power Automate のフローへレポート要約を
POST し、フローが Teams チャットに投稿する。v10 で追加。

```
Worker cron ──POST JSON──▶ Power Automate(HTTP要求の受信時) ──▶ Teams チャット投稿
```

## セットアップ手順

### 1. Power Automate 側でフローを作る

1. [Power Automate](https://make.powerautomate.com/) → 「作成」→「インスタント クラウド フロー」ではなく **「自動化したクラウド フロー」→ スキップ** で空のフローを作る
2. トリガーに **「HTTP 要求の受信時 (When an HTTP request is received)」** を追加
   - 「要求本文の JSON スキーマ」に下の *ペイロードスキーマ* を貼る(「サンプルのペイロードを使用してスキーマを生成する」に下のサンプルを貼ってもよい)
3. アクションに **「チャットまたはチャネルでメッセージを投稿する (Teams)」** を追加
   - 投稿先: 任意のチャット/チャネル
   - メッセージ本文で動的コンテンツ(`summary` / `factors` / `actions` / `report_url` など)を使って整形する
4. 保存すると トリガーに **HTTP POST の URL** が発行されるのでコピーする

### 2. Worker 側に URL を登録(secret)

```sh
cd worker
npx wrangler secret put TEAMS_WEBHOOK_URL   # コピーした URL を貼る
```

- 未設定の間は通知そのものがスキップされる(オプトイン)
- 送信失敗は events(`notify_fail`)に記録されるだけで、レポート生成は止まらない

### 3. 動作確認

secret 登録後、翌朝の cron を待つか、ローカルで `.dev.vars` に `TEAMS_WEBHOOK_URL=...` を
書いて cron をエミュレートする(`wrangler dev --test-scheduled` → `curl "http://localhost:8797/__scheduled?cron=0+22+*+*+*"`)。

## ペイロードスキーマ

Worker が送る JSON(1アカウントにつき1リクエスト):

```json
{
  "kind": "daily",
  "period_start": "2026-07-16",
  "period_end": "2026-07-16",
  "handle": "example_account",
  "followers": 655,
  "followers_delta": 0,
  "summary": "AIによる総評テキスト(講評生成失敗時は空文字)",
  "factors": ["要因1", "要因2"],
  "actions": ["提案1", "提案2"],
  "report_url": "https://sns-follower-tracker.<your-subdomain>.workers.dev/ui/report?kind=daily&period=2026-07-16"
}
```

JSON スキーマ(トリガーに貼る用):

```json
{
  "type": "object",
  "properties": {
    "kind": { "type": "string" },
    "period_start": { "type": "string" },
    "period_end": { "type": "string" },
    "handle": { "type": "string" },
    "followers": { "type": ["integer", "null"] },
    "followers_delta": { "type": ["integer", "null"] },
    "summary": { "type": "string" },
    "factors": { "type": "array", "items": { "type": "string" } },
    "actions": { "type": "array", "items": { "type": "string" } },
    "report_url": { "type": "string" }
  }
}
```

## 実装の所在

- 送信ロジック: `worker/src/lib/teams.ts`(`notifyTeamsReports`)
- 呼び出し: `worker/src/cron.ts`(レポート生成後、kind ごと)
- リンク生成のベース URL: `wrangler.jsonc` の `vars.REPORT_BASE_URL`
