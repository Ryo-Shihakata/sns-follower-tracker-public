import type { Channel } from './base';

/**
 * TODO(フェーズ6): Discord Webhook 送信の実装。
 * - 必要な secret: DISCORD_WEBHOOK_URL (`wrangler secret put DISCORD_WEBHOOK_URL`)
 * - settings.channels_enabled に 'discord' が含まれる場合のみ有効化する
 * - 実装イメージ: fetch(DISCORD_WEBHOOK_URL, { method: 'POST', headers: {'Content-Type':'application/json'},
 *     body: JSON.stringify({ content: event.message }) })
 * - 現時点では未実装(スタブ)。emitEvent() からの自動ディスパッチも未接続。
 */
export class DiscordChannel implements Channel {
  name = 'discord';

  async send(): Promise<void> {
    throw new Error('DiscordChannel is not implemented yet (フェーズ6で実装予定)');
  }
}
