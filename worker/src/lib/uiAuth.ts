/**
 * v11: 設定ビューの権限管理(暫定パスワード方式)。docs/settings-auth.md 参照。
 *
 * - secret SETTINGS_PASSWORD が未設定なら全機能が従来どおり開放される(オプトイン)
 * - ログイン成功で HMAC 署名付きセッション cookie を発行し、設定の書込系
 *   エンドポイントは cookie 検証を必須にする
 * - 将来 Google OAuth に移行する際は「credential 検証(handleLogin)」だけを
 *   OAuth コールバックに差し替え、cookie の発行・検証(この下半分)は共通で使う
 */
import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { timingSafeEqual } from './auth';

const COOKIE_NAME = 'fjsc_settings_auth';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

type Ctx = Context<{ Bindings: Env }>;

// ---- セッション cookie の発行・検証(OAuth 移行後もそのまま使う) ----

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `<有効期限epochMs>.<HMAC>` 形式のセッショントークン。 */
async function signSession(secret: string, expMs: number): Promise<string> {
  return `${expMs}.${await hmacHex(secret, `settings-session:${expMs}`)}`;
}

async function verifySessionToken(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expMs = Number(token.slice(0, dot));
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const expected = await signSession(secret, expMs);
  return timingSafeEqual(token, expected);
}

function readCookie(c: Ctx, name: string): string | undefined {
  const header = c.req.header('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

async function issueSessionCookie(c: Ctx): Promise<void> {
  const secret = c.env.SETTINGS_PASSWORD;
  if (!secret) return;
  const expMs = Date.now() + SESSION_TTL_MS;
  const token = await signSession(secret, expMs);
  c.header(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`
  );
}

/** 認証状態。secret 未設定なら required=false(常に開放)。 */
export async function isAuthed(c: Ctx): Promise<{ required: boolean; authed: boolean }> {
  const secret = c.env.SETTINGS_PASSWORD;
  if (!secret) return { required: false, authed: true };
  const authed = await verifySessionToken(secret, readCookie(c, COOKIE_NAME));
  return { required: true, authed };
}

/** 設定の書込系エンドポイント用ミドルウェア。 */
export async function requireSettingsAuth(c: Ctx, next: Next) {
  const { authed } = await isAuthed(c);
  if (!authed) return c.json({ error: 'settings_auth_required' }, 401);
  await next();
}

// ---- credential 検証(暫定パスワード方式。OAuth 移行時はここだけ差し替える) ----

/** POST /ui/auth/login のハンドラ本体。成功時はセッション cookie を発行する。 */
export async function handleLogin(c: Ctx) {
  const secret = c.env.SETTINGS_PASSWORD;
  if (!secret) return c.json({ ok: true, required: false });
  const body = await c.req.json().catch(() => null);
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!password || !timingSafeEqual(password, secret)) {
    return c.json({ error: 'invalid password' }, 401);
  }
  await issueSessionCookie(c);
  return c.json({ ok: true });
}
