/**
 * 計画書 §5.8: events への書込を一元化する emitEvent()。
 * ダッシュボード(W2)・GET /api/events(W2)・cron 鮮度点検(W3)から共通で呼ばれる。
 */
export type EventType = 'collect_fail' | 'anomaly' | 'stale' | 'post_spike' | 'slump' | 'llm_fail' | 'notify_fail';

export interface EmitEventInput {
  type: EventType;
  accountId: number | null;
  message: string;
  payload?: Record<string, unknown>;
}

export async function emitEvent(db: D1Database, input: EmitEventInput): Promise<number> {
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
  const res = await db
    .prepare(
      `INSERT INTO events (type, account_id, message, payload_json) VALUES (?, ?, ?, ?)`
    )
    .bind(input.type, input.accountId, input.message, payloadJson)
    .run();
  // TODO(フェーズ6): settings.channels_enabled を見て channels/ (discord.ts / line.ts) へディスパッチする
  return Number(res.meta.last_row_id);
}
