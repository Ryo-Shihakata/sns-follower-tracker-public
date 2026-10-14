/**
 * docs/insights-reports-plan.md §4: LLM 講評のプロバイダ抽象化。
 * Workers AI で開始し、env.LLM_PROVIDER='anthropic' + ANTHROPIC_API_KEY で
 * Claude Haiku へ切替可能。数値の再計算は LLM にさせず、解釈のみを
 * JSON({summary, factors[], actions[]})で返させる(表示は必ず metrics_json 由来)。
 */
import type { Env } from '../types';

export interface LlmProvider {
  readonly model: string;
  generate(system: string, prompt: string): Promise<string>;
}

const WORKERS_AI_MODEL = '@cf/openai/gpt-oss-120b';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';

export class WorkersAiProvider implements LlmProvider {
  readonly model = WORKERS_AI_MODEL;
  constructor(private readonly ai: Ai) {}

  async generate(system: string, prompt: string): Promise<string> {
    const out = await this.ai.run(WORKERS_AI_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
    });
    return extractText(out);
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly model = ANTHROPIC_MODEL;
  constructor(private readonly apiKey: string) {}

  async generate(system: string, prompt: string): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic api error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json<{ content?: Array<{ type: string; text?: string }> }>();
    return (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
}

/**
 * ai.run のレスポンスからテキストを取り出す。モデル/バージョンにより形が異なる:
 * - 旧形式: `{ response: "..." }`
 * - OpenAI 互換形式: `{ choices: [{ message: { content: "..." } }] }`
 *   (llama-3.3-70b-instruct-fp8-fast は messages 入力に対しこちらを返す。
 *    2026-07-17 に本番講評が全滅した実測原因 — response しか見ていなかった)
 */
function extractText(out: unknown): string {
  if (typeof out === 'string') return out;
  if (!out || typeof out !== 'object') return '';
  const o = out as Record<string, unknown>;
  if (typeof o.response === 'string') return o.response;
  if (Array.isArray(o.choices) && o.choices.length > 0) {
    const message = (o.choices[0] as Record<string, unknown> | undefined)?.message;
    const content = (message as Record<string, unknown> | undefined)?.content;
    if (typeof content === 'string') return content;
  }
  console.error('workers-ai: unexpected ai.run output shape:', JSON.stringify(out).slice(0, 300));
  return '';
}

/** LLM_PROVIDER='anthropic' かつ API キー設定時のみ Anthropic。それ以外は Workers AI。 */
export function selectProvider(env: Env): LlmProvider {
  if (env.LLM_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(env.ANTHROPIC_API_KEY);
  }
  if (!env.AI) {
    // binding 欠落は設定ミス。無言の講評欠落ではなく明示エラーで気づけるようにする。
    throw new Error('AI binding is not configured (wrangler.jsonc の ai.binding を確認)');
  }
  return new WorkersAiProvider(env.AI);
}

/** reports.llm_json に保存する形。 */
export interface LlmCommentary {
  summary: string;
  factors: string[];
  actions: string[];
  model: string;
  generated_at: string;
}

const SYSTEM_PROMPT =
  'あなたは高校生徒会のSNS運用アドバイザー。読者は生徒会メンバー(非専門家)。平易な日本語で書く。';

/**
 * metrics の要約(reports.ts 側で組み立てた縮約オブジェクト)を渡して講評を生成する。
 * レスポンスから最初の {...} を防御的に抽出してパースし、失敗は null(呼び出し側で
 * 「講評なし」として扱う)。プロバイダの通信エラー等は throw のまま伝播する。
 */
export async function generateCommentary(
  provider: LlmProvider,
  metricsSummary: unknown
): Promise<LlmCommentary | null> {
  const prompt = [
    '以下はInstagramアカウントの集計済みレポートデータ(JSON)です。',
    'この数値を解釈し、次の形のJSONだけを出力してください(前置き・後置きの文章やコードブロック記法は不要):',
    '{"summary": "総評2-3文", "factors": ["伸びた/落ちた要因の箇条書き"], "actions": ["次のアクション提案1-3件"]}',
    '数値の再計算や新しい数値の作成はせず、与えられた値の解釈だけを書いてください。',
    '',
    JSON.stringify(metricsSummary),
  ].join('\n');

  const raw = await provider.generate(SYSTEM_PROMPT, prompt);
  const parsed = extractFirstJsonObject(raw);
  if (!parsed) return null;

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) return null;
  return {
    summary,
    factors: toStringArray(parsed.factors),
    actions: toStringArray(parsed.actions),
    model: provider.model,
    generated_at: new Date().toISOString(),
  };
}

/** テキスト中の最初の '{' から最後の '}' までを JSON として試しにパースする。 */
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

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}
