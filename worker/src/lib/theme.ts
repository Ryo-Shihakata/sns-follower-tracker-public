/**
 * 共有テーマ層。ダッシュボード(dashboardHtml)とモニター(monitorHtml)が共有する:
 *   - Kumo(@cloudflare/kumo)のデザイン言語をCSS変数として移植したトークン
 *     (セマンティックカラー / タイポ / 角丸 / 余白)。ブランドアクセント=Cloudflareオレンジ #f6821f、
 *     インタラクティブ=ブルー、サーフェス階層 canvas/elevated/base、セマンティック emerald/red/yellow。
 *   - フォント Noto Sans JP(Google Fonts。CSPは未設定のため読込可。SW がオフライン用にキャッシュ)。
 *   - PWA(SCTracker)の <head> メタ(manifest / apple-touch / theme-color / iOS対応)。
 *   - Phosphor 風のインライン SVG アイコン。
 *
 * データ可視化の系列色(--followers 等)は v3 で dataviz バリデータを通した配色をそのまま維持し、
 * クローム(サーフェス/文字/境界/操作色)だけ Kumo に寄せている。
 */

export const KUMO_TOKENS = `
:root {
  color-scheme: light dark;
  /* --- Kumo surfaces (light) --- */
  --k-canvas: #fafafa;        /* ページ背景 */
  --k-elevated: #fbfbfb;
  --k-base: #ffffff;          /* カード面 */
  --k-recessed: #f4f4f5;      /* 沈み込み(入力/セグメント溝) */
  --k-line: #e4e4e7;          /* 境界 */
  --k-line-strong: #d4d4d8;
  /* --- text --- */
  --k-text: #18181b;
  --k-text-strong: #09090b;
  --k-text-subtle: #71717a;
  --k-text-inactive: #a1a1aa;
  /* --- brand / interactive / semantic --- */
  --k-brand: #f6821f;         /* Cloudflare orange(ブランドアクセント) */
  --k-interactive: #2563eb;   /* 主要操作(ボタン/選択) */
  --k-interactive-hover: #1d4ed8;
  --k-link: #1d4ed8;
  --k-success: #047857;
  --k-success-bg: #ecfdf5;
  --k-danger: #dc2626;
  --k-danger-bg: #fef2f2;
  --k-warning: #b45309;
  --k-warning-bg: #fffbeb;
  --k-focus: rgba(37,99,235,0.35);
  /* --- data-viz(v3 の検証済みパレットを維持) --- */
  --followers: #d55181;
  --followers-fill: rgba(232,123,164,0.22);
  --up: #0ca30c;
  --down: #eb6834;
  --violet: #4a3aa7;
  --axis: #c3c2b7;
  --grid: #e7e7ea;
  /* --- shape --- */
  --radius-sm: 6px;
  --radius: 9px;
  --radius-lg: 13px;
  --shadow-sm: 0 1px 2px rgba(9,9,11,0.05), 0 1px 3px rgba(9,9,11,0.04);
  --shadow: 0 4px 14px rgba(9,9,11,0.10);
  --font-jp: "Noto Sans JP", system-ui, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --k-canvas: #0b0b0c;
    --k-elevated: #131314;
    --k-base: #1a1a1c;
    --k-recessed: #151517;
    --k-line: #2a2a2d;
    --k-line-strong: #3a3a3e;
    --k-text: #f4f4f5;
    --k-text-strong: #fafafa;
    --k-text-subtle: #a1a1aa;
    --k-text-inactive: #6b6b70;
    --k-brand: #f6821f;
    --k-interactive: #3b82f6;
    --k-interactive-hover: #60a5fa;
    --k-link: #60a5fa;
    --k-success: #34d399;
    --k-success-bg: rgba(52,211,153,0.12);
    --k-danger: #f87171;
    --k-danger-bg: rgba(248,113,113,0.12);
    --k-warning: #fbbf24;
    --k-warning-bg: rgba(251,191,36,0.12);
    --k-focus: rgba(96,165,250,0.4);
    --followers: #d55181;
    --followers-fill: rgba(213,81,129,0.20);
    --up: #0ca30c;
    --down: #d95926;
    --violet: #9085e9;
    --axis: #383835;
    --grid: #26262a;
  }
}
`;

/** 全ページ共通の要素/コンポーネント基本スタイル(Kumo 言語)。 */
export const KUMO_BASE = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--font-jp);
  background: var(--k-canvas);
  color: var(--k-text);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--k-link); }
button { cursor: pointer; font-family: inherit; }
select, input, textarea {
  font-family: inherit;
  background: var(--k-base);
  color: var(--k-text);
  border: 1px solid var(--k-line);
  border-radius: var(--radius-sm);
  padding: 0.44rem 0.6rem;
  font-size: 0.9rem;
}
select:focus, input:focus, textarea:focus, button:focus-visible {
  outline: 2px solid var(--k-focus);
  outline-offset: 1px;
  border-color: var(--k-interactive);
}
/* ボタン */
.btn {
  display: inline-flex; align-items: center; gap: 0.35rem;
  border: 1px solid transparent; border-radius: var(--radius-sm);
  padding: 0.44rem 0.8rem; font-size: 0.86rem; font-weight: 600;
  line-height: 1; white-space: nowrap;
}
.btn-primary { background: var(--k-interactive); color: #fff; }
.btn-primary:hover { background: var(--k-interactive-hover); }
.btn-ghost { background: transparent; color: var(--k-text); border-color: var(--k-line); }
.btn-ghost:hover { background: var(--k-recessed); }
.btn-danger { background: transparent; color: var(--k-danger); border-color: var(--k-line); }
.btn-danger:hover { background: var(--k-danger-bg); border-color: var(--k-danger); }
.btn-sm { padding: 0.3rem 0.55rem; font-size: 0.8rem; }
/* カード */
.card {
  background: var(--k-base);
  border: 1px solid var(--k-line);
  border-radius: var(--radius-lg);
  padding: 1rem 1.15rem;
  box-shadow: var(--shadow-sm);
}
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 0.7rem; flex-wrap: wrap; }
.card-head h2 { margin: 0; font-size: 0.95rem; font-weight: 700; letter-spacing: 0.01em; }
.hint { font-size: 0.78rem; color: var(--k-text-subtle); }
/* バッジ(Kumo semantic) */
.badge { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.12rem 0.5rem; border-radius: 999px; font-size: 0.72rem; font-weight: 700; }
.badge-danger { background: var(--k-danger-bg); color: var(--k-danger); }
.badge-warning { background: var(--k-warning-bg); color: var(--k-warning); }
.badge-neutral { background: var(--k-recessed); color: var(--k-text-subtle); }
.badge-brand { background: rgba(246,130,31,0.14); color: var(--k-brand); }
/* テーブル */
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { border-bottom: 1px solid var(--k-line); padding: 0.5rem 0.6rem; text-align: right; white-space: nowrap; }
th { color: var(--k-text-subtle); font-weight: 600; }
th:first-child, td:first-child { text-align: left; }
.chart-host svg { display: block; width: 100%; height: auto; }
/* スパークライン系は固定 width 属性を持つため、狭いカードで溢れないよう
   コンテナ幅にフィットさせる(高さはコンテナ固定値を使い、歪みは許容)。 */
.kpi-spark svg, .acc-spark svg, .post-spark svg { display: block; width: 100%; height: 100%; }
`;

/** Google Fonts(Noto Sans JP)+ アイコン/ファビコン の link 群。 */
const FONT_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;800&display=swap" />`;

/**
 * PWA(SCTracker)対応の <head> メタ群を返す(<style> は各ページで別途差し込む)。
 * iOS のホーム画面追加・ステータスバー・セーフエリアに対応。
 */
export function headMeta(title: string, opts?: { themeColor?: string }): string {
  const theme = opts?.themeColor ?? '#ffffff';
  return `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title}</title>
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" href="/icons/favicon-32.png" sizes="32x32" />
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<meta name="application-name" content="SCTracker" />
<meta name="apple-mobile-web-app-title" content="SCTracker" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${theme}" />
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0b0c" />
${FONT_LINKS}`;
}

/** Service Worker 登録スクリプト(末尾に差し込む)。 */
export const SW_REGISTER = `<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
</script>`;

/** サイドバー/ヘッダーのロゴ(assets の SVG を参照)。 */
export function logoImg(size = 24): string {
  return `<img src="/icons/icon.svg" width="${size}" height="${size}" alt="SCTracker" style="border-radius:6px;display:block" />`;
}

/** Phosphor 風インライン SVG アイコン(24x24, currentColor)。 */
export function icon(name: string, size = 18): string {
  const paths: Record<string, string> = {
    overview: '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
    posts: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="9" r="1.8"/><path d="M4 17l4.5-4 3 2.5L15 11l5 5"/>',
    audience: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 6.5a3 3 0 0 1 0 5.6"/><path d="M18 19c0-2.2-1-3.8-2.6-4.6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1m11.4-11.4 2.1-2.1"/>',
    events: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 8-2 8h16s-2-2-2-8Z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    all: '<circle cx="8" cy="8" r="2.6"/><circle cx="16" cy="8" r="2.6"/><path d="M3 18c0-2.5 2.2-4.2 5-4.2s5 1.7 5 4.2"/><path d="M13.5 13.9c2.6-.2 4.5 1.5 4.5 4.1"/>',
    monitor: '<path d="M14 3h7v7"/><path d="M21 3l-9 9"/><path d="M10 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 6.5l3 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M4 12l5 5L20 6"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  };
  const p = paths[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
