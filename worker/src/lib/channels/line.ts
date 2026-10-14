import type { Channel } from './base';

/**
 * TODO(フェーズ6): LINE Messaging API (push) での通知実装。
 * - 必要な secret: LINE_CHANNEL_ACCESS_TOKEN(`wrangler secret put`)
 * - 宛先方式(個人push か LINE Notify 代替か)は計画書 §12 未確定TODO。フェーズ6で確定する。
 * - settings.channels_enabled に 'line' が含まれる場合のみ有効化する
 * - 現時点では未実装(スタブ)。emitEvent() からの自動ディスパッチも未接続。
 */
export class LineChannel implements Channel {
  name = 'line';

  async send(): Promise<void> {
    throw new Error('LineChannel is not implemented yet (フェーズ6で実装予定)');
  }
}
