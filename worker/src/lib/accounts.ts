/**
 * accounts テーブルへのアクセスをまとめるリポジトリ層。
 * routes/accounts.ts (Bearer INGEST_SECRET, collector向け) と、
 * W2 で追加するダッシュボードの管理パネル(同一Worker内から直接呼び出し、
 * ブラウザにINGEST_SECRETを渡さない設計)の両方から使う想定。
 */
export interface AccountRow {
  id: number;
  platform_id: string;
  handle: string;
  display_name: string | null;
  active: number;
  managed: number;
  created_at: string;
}

export async function findAccount(
  db: D1Database,
  platformId: string,
  handle: string
): Promise<AccountRow | null> {
  return db
    .prepare(`SELECT * FROM accounts WHERE platform_id = ? AND handle = ?`)
    .bind(platformId, handle)
    .first<AccountRow>();
}

export async function listAccounts(
  db: D1Database,
  opts?: { activeOnly?: boolean }
): Promise<AccountRow[]> {
  const activeOnly = opts?.activeOnly ?? false;
  const query = activeOnly
    ? `SELECT * FROM accounts WHERE active = 1 ORDER BY id`
    : `SELECT * FROM accounts ORDER BY id`;
  const { results } = await db.prepare(query).all<AccountRow>();
  return results ?? [];
}

export interface CreateAccountInput {
  platform_id: string;
  handle: string;
  display_name?: string | null;
  active?: boolean;
  managed?: boolean;
}

export async function createAccount(db: D1Database, input: CreateAccountInput): Promise<number> {
  const active = input.active === false ? 0 : 1;
  const managed = input.managed ? 1 : 0;
  const res = await db
    .prepare(
      `INSERT INTO accounts (platform_id, handle, display_name, active, managed) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(input.platform_id, input.handle, input.display_name ?? null, active, managed)
    .run();
  return Number(res.meta.last_row_id);
}

export interface AccountPatch {
  active?: boolean;
  managed?: boolean;
  display_name?: string | null;
  handle?: string;
}

export async function updateAccount(
  db: D1Database,
  id: number,
  patch: AccountPatch
): Promise<AccountRow | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.active !== undefined) {
    fields.push('active = ?');
    values.push(patch.active ? 1 : 0);
  }
  if (patch.managed !== undefined) {
    fields.push('managed = ?');
    values.push(patch.managed ? 1 : 0);
  }
  if (patch.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(patch.display_name);
  }
  if (patch.handle !== undefined) {
    fields.push('handle = ?');
    values.push(patch.handle);
  }
  if (fields.length === 0) {
    return db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
  }
  values.push(id);
  await db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
}

/**
 * アカウントと、それに紐づく全時系列(snapshots / posts / post_snapshots /
 * collection_runs / events)を削除する。FK 制約を張っていないので手動で子から消す。
 */
export async function deleteAccount(db: D1Database, id: number): Promise<boolean> {
  const exists = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(id).first();
  if (!exists) return false;
  await db.batch([
    db.prepare(
      `DELETE FROM post_snapshots WHERE post_id IN (SELECT id FROM posts WHERE account_id = ?)`
    ).bind(id),
    db.prepare(`DELETE FROM posts WHERE account_id = ?`).bind(id),
    db.prepare(`DELETE FROM snapshots WHERE account_id = ?`).bind(id),
    db.prepare(`DELETE FROM collection_runs WHERE account_id = ?`).bind(id),
    db.prepare(`DELETE FROM events WHERE account_id = ?`).bind(id),
    db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id),
  ]);
  return true;
}
