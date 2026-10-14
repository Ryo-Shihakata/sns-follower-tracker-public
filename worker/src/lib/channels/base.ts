import type { EmitEventInput } from '../events';

/**
 * 計画書 §5.8 / §7: 通知チャネルの共通 IF。
 * 新チャネル追加手順: ①channels/<name>.ts に Channel 実装 → ②secret追加 →
 * ③settings.channels_enabled に名前を足す。events の発生側(emitEvent 呼び出し元)は変更不要。
 */
export interface Channel {
  name: string;
  send(event: EmitEventInput): Promise<void>;
}
