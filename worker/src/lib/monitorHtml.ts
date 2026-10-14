import type { AccountRow } from './accounts';
import { headMeta, SW_REGISTER, logoImg } from './theme';

export interface MonitorAccountLite {
  id: number;
  handle: string;
  display_name: string | null;
}

export interface MonitorHtmlOptions {
  accounts: MonitorAccountLite[]; // 巡回対象(active)
  defaultAccountId: number;
  rotate: boolean;
  refreshSeconds: number;
}

export function toMonitorAccounts(rows: AccountRow[]): MonitorAccountLite[] {
  return rows.map((a) => ({ id: a.id, handle: a.handle, display_name: a.display_name }));
}

/**
 * モニターモード(計画書 §2.2)。壁掛けモニタ向けの大型・ダーク基調・自動更新表示。
 * 数値は同一オリジンの /ui/monitor から取得する(READ_API_TOKEN を埋め込まない)。
 * 外部 CDN 不可のためチャート(スパークライン)は手書き SVG でインライン生成する。
 *
 * 配色(dataviz スキル準拠 / 参考画像のトーン):
 *   フォロワー=マゼンタ #d55181、増=緑 #0ca30c ▲、減=橙 #d95926 ▼。
 */
export function renderMonitorHtml(opts: MonitorHtmlOptions): string {
  const cfg = JSON.stringify({
    accounts: opts.accounts,
    defaultAccountId: opts.defaultAccountId,
    rotate: opts.rotate,
    refreshSeconds: opts.refreshSeconds,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ja">
<head>
${headMeta('モニター — SCTracker', { themeColor: '#0d0d0d' })}
<style>
${CSS}
</style>
</head>
<body>
  <div id="root" class="mon-root">
    <div class="mon-topbar">
      <span class="mon-brand">${logoImg(30)}<span id="mon-handle" class="mon-handle">@—</span></span>
      <span id="mon-updated" class="mon-updated">—</span>
    </div>

    <div class="mon-hero">
      <div class="mon-hero-label">現在のフォロワー数</div>
      <div class="mon-hero-row">
        <span id="mon-followers" class="mon-followers">—</span>
        <span id="mon-delta" class="mon-delta"></span>
      </div>
      <svg id="mon-spark" class="mon-spark" viewBox="0 0 800 90" preserveAspectRatio="none" aria-hidden="true"></svg>
    </div>

    <div class="mon-posts-label">最新の投稿</div>
    <div id="mon-posts" class="mon-posts"></div>

    <div id="mon-dots" class="mon-dots"></div>
  </div>

<script>
window.__MON__ = ${cfg};
${JS}
</script>
${SW_REGISTER}
</body>
</html>`;
}

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0d0d0d;
  --surface: #1a1a19;
  --text: #ffffff;
  --secondary: #c3c2b7;
  --muted: #898781;
  --border: rgba(255,255,255,0.10);
  --followers: #d55181;
  --up: #0ca30c;
  --down: #d95926;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: "Noto Sans JP", system-ui, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.mon-brand { display: inline-flex; align-items: center; gap: 0.6rem; }
.mon-brand img { border-radius: 7px; }
.mon-root {
  min-height: 100%;
  padding: clamp(1rem, 3vw, 3rem);
  display: flex;
  flex-direction: column;
  gap: clamp(1rem, 3vh, 2.5rem);
}
.mon-topbar {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  flex-wrap: wrap;
}
.mon-handle { font-size: clamp(1.4rem, 3.5vw, 2.6rem); font-weight: 700; color: var(--followers); }
.mon-updated { font-size: clamp(0.9rem, 1.6vw, 1.2rem); color: var(--muted); font-variant-numeric: tabular-nums; }
.mon-hero {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: clamp(1.2rem, 4vw, 3rem);
}
.mon-hero-label { font-size: clamp(1rem, 2vw, 1.6rem); color: var(--secondary); margin-bottom: 0.4rem; }
.mon-hero-row { display: flex; align-items: baseline; gap: clamp(1rem, 3vw, 2.5rem); flex-wrap: wrap; }
.mon-followers {
  font-size: clamp(3.5rem, 15vw, 11rem);
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.mon-delta {
  font-size: clamp(1.4rem, 4vw, 3rem);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.mon-delta small { display: block; font-size: 0.5em; font-weight: 500; color: var(--muted); }
.mon-delta.up { color: var(--up); }
.mon-delta.down { color: var(--down); }
.mon-spark { display: block; width: 100%; height: clamp(48px, 9vh, 90px); margin-top: clamp(0.8rem, 2vh, 1.6rem); }
.mon-posts-label { font-size: clamp(1rem, 2vw, 1.6rem); color: var(--secondary); }
.mon-posts { display: grid; grid-template-columns: repeat(3, 1fr); gap: clamp(0.8rem, 2vw, 1.6rem); }
.mon-post {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: clamp(1rem, 3vw, 2rem);
  text-align: center;
}
.mon-post .lk-label { font-size: clamp(0.9rem, 1.6vw, 1.3rem); color: var(--muted); }
.mon-post .lk-value {
  font-size: clamp(2rem, 7vw, 5rem);
  font-weight: 800;
  line-height: 1.1;
  color: var(--followers);
  font-variant-numeric: tabular-nums;
}
.mon-post .lk-date { font-size: clamp(0.85rem, 1.5vw, 1.2rem); color: var(--secondary); margin-top: 0.3rem; }
.mon-dots { display: flex; gap: 0.5rem; justify-content: center; }
.mon-dots span { width: 10px; height: 10px; border-radius: 999px; background: var(--muted); opacity: 0.35; }
.mon-dots span.on { opacity: 1; background: var(--followers); }
@media (max-width: 640px) {
  .mon-posts { grid-template-columns: 1fr; }
}
`;

const JS = `
(function () {
  var CFG = window.__MON__;
  var accounts = CFG.accounts || [];
  var order = CFG.rotate && accounts.length > 0
    ? accounts.map(function (a) { return a.id; })
    : [CFG.defaultAccountId];
  var idx = Math.max(0, order.indexOf(CFG.defaultAccountId));
  if (idx < 0) idx = 0;

  var nf = new Intl.NumberFormat('ja-JP');

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 10);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fmtUpdated(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function drawSpark(values) {
    var svg = document.getElementById('mon-spark');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!values || values.length < 2) return;
    var W = 800, H = 90, pad = 6;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    if (min === max) { min -= 1; max += 1; }
    var n = values.length;
    function x(i) { return pad + (i / (n - 1)) * (W - 2 * pad); }
    function y(v) { return H - pad - ((v - min) / (max - min)) * (H - 2 * pad); }
    var dLine = '';
    for (var i = 0; i < n; i++) { dLine += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(values[i]).toFixed(1) + ' '; }
    var dArea = dLine + 'L' + x(n - 1).toFixed(1) + ' ' + H + ' L' + x(0).toFixed(1) + ' ' + H + ' Z';
    var ns = 'http://www.w3.org/2000/svg';
    var area = document.createElementNS(ns, 'path');
    area.setAttribute('d', dArea);
    area.setAttribute('fill', '#d55181');
    area.setAttribute('fill-opacity', '0.15');
    svg.appendChild(area);
    var line = document.createElementNS(ns, 'path');
    line.setAttribute('d', dLine);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#d55181');
    line.setAttribute('stroke-width', '2.5');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
  }

  function renderDots() {
    var el = document.getElementById('mon-dots');
    el.innerHTML = '';
    if (order.length < 2) return;
    order.forEach(function (_, i) {
      var s = document.createElement('span');
      if (i === idx) s.className = 'on';
      el.appendChild(s);
    });
  }

  function render(m) {
    document.getElementById('mon-handle').textContent = '@' + (m.handle || '');
    document.getElementById('mon-updated').textContent = fmtUpdated(m.collected_at) + ' 更新';
    document.getElementById('mon-followers').textContent =
      m.followers == null ? '—' : nf.format(m.followers);

    var deltaEl = document.getElementById('mon-delta');
    if (m.day_delta == null) {
      deltaEl.textContent = '';
      deltaEl.className = 'mon-delta';
    } else {
      var up = m.day_delta >= 0;
      var arrow = up ? '\\u25B2' : '\\u25BC';
      var sign = up ? '+' : '';
      var pct = m.day_pct == null ? '' : ' (' + sign + (m.day_pct * 100).toFixed(2) + '%)';
      deltaEl.className = 'mon-delta ' + (up ? 'up' : 'down');
      deltaEl.innerHTML = arrow + ' ' + sign + nf.format(m.day_delta) + pct + '<small>前日比</small>';
    }

    drawSpark(m.sparkline || []);

    var posts = document.getElementById('mon-posts');
    posts.innerHTML = '';
    var list = (m.latest_posts || []).slice(0, 3);
    if (list.length === 0) {
      posts.innerHTML = '<div class="mon-post"><div class="lk-label">投稿データなし</div></div>';
    } else {
      list.forEach(function (p) {
        var card = document.createElement('div');
        card.className = 'mon-post';
        card.innerHTML =
          '<div class="lk-label">いいね</div>' +
          '<div class="lk-value">' + (p.likes == null ? 'N/A' : nf.format(p.likes)) + '</div>' +
          '<div class="lk-date">' + fmtDate(p.posted_at) + ' 投稿</div>';
        posts.appendChild(card);
      });
    }
    renderDots();
  }

  function load() {
    var id = order[idx];
    fetch('/ui/monitor?account_id=' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (data) { if (data && data.monitor) render(data.monitor); })
      .catch(function () {});
  }

  // 自動更新: 同じアカウントを refreshSeconds ごとに再取得。
  var refreshMs = Math.max(30, CFG.refreshSeconds || 300) * 1000;
  setInterval(load, refreshMs);

  // 巡回: rotate=1 のときは 15 秒ごとに次のアカウントへ。
  if (order.length > 1) {
    setInterval(function () {
      idx = (idx + 1) % order.length;
      load();
    }, 15000);
  }

  load();
})();
`;
