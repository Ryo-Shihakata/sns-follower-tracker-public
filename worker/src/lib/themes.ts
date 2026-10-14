/**
 * docs/insights-v9-plan.md Phase B-2: 投稿テーマの LLM 一括分類。
 * cron の runReportGeneration からレポート生成前に managed アカウントごとに呼ばれる。
 * theme IS NULL かつ直近90日の投稿を最大20件取り、固定候補へ分類して posts.theme を UPDATE する。
 * LLM 失敗・パース失敗時は何も更新しない(翌日以降の cron 実行で再試行される)。
 */
import type { Env } from '../types';
import { selectProvider } from './llm';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TARGETS = 20;

/** 固定テーマ候補。LLM がこれ以外を返した場合は「その他」に丸める。 */
export const THEME_CANDIDATES = ['行事', 'お知らせ', '活動報告', '日常', 'その他'] as const;
export type ThemeCandidate = (typeof THEME_CANDIDATES)[number];

const THEME_SET: Set<string> = new Set(THEME_CANDIDATES);

const SYSTEM_PROMPT =
  'あなたはSNS投稿の分類アシスタント。与えられた投稿のキャプションから、指定された候補の中から最も当てはまるテーマを1つ選ぶ。';

interface TargetPost {
  id: number;
  external_id: string;
  caption_head: string | null;
}

export interface ClassifyThemesResult {
  targeted: number;
  updated: number;
}

/** テキスト中の最初の '{' から最後の '}' までを JSON として試しにパースする(llm.ts と同じ流儀)。 */
function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeTheme(v: unknown): ThemeCandidate {
  return typeof v === 'string' && THEME_SET.has(v) ? (v as ThemeCandidate) : 'その他';
}

export async function classifyThemes(
  env: Env,
  db: D1Database,
  accountId: number
): Promise<ClassifyThemesResult> {
  const cutoff = new Date(Date.now() - 90 * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, external_id, caption_head FROM posts
       WHERE account_id = ? AND theme IS NULL AND posted_at IS NOT NULL AND posted_at >= ?
       ORDER BY posted_at DESC LIMIT ?`
    )
    .bind(accountId, cutoff, MAX_TARGETS)
    .all<TargetPost>();
  const targets = results ?? [];
  if (targets.length === 0) return { targeted: 0, updated: 0 };

  const prompt = [
    '以下はSNS投稿のキャプション先頭部分の一覧です。',
    `各投稿を次の候補のいずれか1つに分類してください: ${THEME_CANDIDATES.join(' / ')}`,
    'JSONオブジェクトのみを出力してください(前置き・後置きの文章やコードブロック記法は不要)。',
    'キーは投稿のexternal_id、値はテーマ名です。例: {"abc123": "行事"}',
    '',
    JSON.stringify(
      targets.map((t) => ({ external_id: t.external_id, caption_head: t.caption_head ?? '' }))
    ),
  ].join('\n');

  const provider = selectProvider(env);
  let raw: string;
  try {
    raw = await provider.generate(SYSTEM_PROMPT, prompt);
  } catch (e) {
    console.error(`theme classification failed (account_id=${accountId}):`, e);
    return { targeted: targets.length, updated: 0 };
  }

  const parsed = extractFirstJsonObject(raw);
  if (!parsed) {
    console.error(`theme classification: パース失敗 (account_id=${accountId})`);
    return { targeted: targets.length, updated: 0 };
  }

  let updated = 0;
  for (const t of targets) {
    if (!(t.external_id in parsed)) continue;
    const theme = normalizeTheme(parsed[t.external_id]);
    await db
      .prepare(`UPDATE posts SET theme = ? WHERE id = ?`)
      .bind(theme, t.id)
      .run();
    updated += 1;
  }

  return { targeted: targets.length, updated };
}
