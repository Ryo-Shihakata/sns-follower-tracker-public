export type SettingsMap = Record<string, string>;

export async function getSettingsMap(db: D1Database): Promise<SettingsMap> {
  const { results } = await db
    .prepare(`SELECT key, value FROM settings`)
    .all<{ key: string; value: string }>();
  const map: SettingsMap = {};
  for (const row of results ?? []) {
    map[row.key] = row.value;
  }
  return map;
}

export function getNumberSetting(map: SettingsMap, key: string, fallback: number): number {
  const raw = map[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
