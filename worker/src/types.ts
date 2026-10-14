export type Env = {
  DB: D1Database;
  // Workers AI(レポート講評)。docs/insights-reports-plan.md §4
  AI: Ai;
  // 書込系(collector→Workers)。計画書 §6
  INGEST_SECRET: string;
  // 読取系(外部ダッシュボード含む)。計画書 §6
  READ_API_TOKEN: string;
  // LLM プロバイダ切替(docs/insights-reports-plan.md §4)。
  // 'anthropic' + ANTHROPIC_API_KEY 設定時のみ Anthropic、それ以外 Workers AI。
  LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  // v10: Power Automate 経由の Teams 通知(docs/teams-notification.md)。
  // secret。未設定なら通知しない。
  TEAMS_WEBHOOK_URL?: string;
  // v11: 設定ビューの暫定パスワード(docs/settings-auth.md)。secret。未設定なら設定は開放。
  SETTINGS_PASSWORD?: string;
  // レポートページへのリンク生成用の公開ベースURL(wrangler.jsonc vars)。
  REPORT_BASE_URL?: string;
};
