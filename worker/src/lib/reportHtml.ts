import { KUMO_TOKENS, KUMO_BASE, headMeta, SW_REGISTER, logoImg } from './theme';

/**
 * 日次/週次/月次レポートページ(insights-reports-plan §5)。GET /ui/report。
 *
 * - データは同一オリジンの /ui/reports(一覧)と /ui/reports/:kind/:period_start(本文)から
 *   取得する。既存 /ui ページと同じく Cloudflare Access 配下・Bearer 非埋込の前提。
 * - 想定読者は生徒会メンバー(非専門家)。指標名には平易な日本語ラベルを添え、
 *   末尾に用語説明の脚注を置く。
 * - ブラウザの「PDFに保存」でそのまま A4 縦の報告資料になるよう @media print を持つ
 *   (操作UIを隠し、常にライト配色、カード/表の泣き別れ防止、印刷ヘッダに期間+アカウント名)。
 * - チャートは既存ページと同じ手書きインライン SVG(外部CDN不可)。SVG の塗り/文字色は
 *   CSS クラス経由でテーマ変数を参照させ、印刷時のライト強制が SVG にも効くようにする。
 * - llm(講評)が null でも数値セクションだけで完結する(講評系セクションは非表示)。
 * - API 未デプロイでも検証できるよう、?mock=1(講評あり)/ ?mock=nollm(講評なし)で
 *   契約準拠のモックデータを注入するモードを持つ(D1 に触れない)。
 */
export function renderReportHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
${headMeta('レポート — SCTracker')}
<style>
${KUMO_TOKENS}
${KUMO_BASE}
${CSS}
</style>
</head>
<body>
<div class="report-shell">
  <header class="toolbar no-print">
    <div class="brand">${logoImg(24)}<span class="brand-name">SCTracker</span><span class="crumb">レポート</span></div>
    <div class="toolbar-controls">
      <div class="seg" id="kind-tabs">
        <button data-kind="daily" class="active">日報</button>
        <button data-kind="weekly">週報</button>
        <button data-kind="monthly">月報</button>
      </div>
      <select id="period-select" aria-label="対象期間"></select>
      <button class="btn btn-primary" id="print-btn">${PRINT_ICON}PDFとして保存</button>
      <a class="btn btn-ghost" href="/">ダッシュボード</a>
    </div>
  </header>

  <div id="report-status" class="card status-card" hidden></div>

  <article id="report-body" hidden>
    <!-- 印刷時もこのヘッダが1ページ目の頭に出る(期間・アカウント名) -->
    <header class="report-head">
      <div class="rh-main">
        <h1 id="rp-title">—</h1>
        <div class="rp-meta">
          <span id="rp-account" class="rp-account">—</span>
          <span id="rp-period">—</span>
        </div>
      </div>
      <div class="rh-brand">
        <span class="rh-logo">${logoImg(18)}SCTracker</span>
        <span id="rp-created" class="rp-created"></span>
      </div>
    </header>

    <!-- ② KPI行 -->
    <section class="kpi-grid" id="kpi-grid"></section>

    <!-- ②-b 予測(forecast。null時は非表示) -->
    <section class="card avoid-break forecast-card" id="sec-forecast" hidden>
      <p class="forecast-line" id="forecast-line"></p>
      <p class="forecast-goal" id="forecast-goal" hidden></p>
    </section>

    <!-- ②-c トレンド(週報・月報のみ。trend が null なら非表示) -->
    <section class="card avoid-break" id="sec-trend" hidden>
      <div class="card-head"><h2>フォロワーの推移(直近12期間)</h2><span class="hint">上: フォロワー数(折れ線) / 下: 期間ごとの純増減(棒)</span></div>
      <div class="chart-host" id="chart-trend-line"></div>
      <div class="chart-host" id="chart-trend-bar"></div>
    </section>

    <!-- ③ 総評(LLM。null時は非表示) -->
    <section class="card avoid-break" id="sec-summary" hidden>
      <div class="card-head"><h2>総評</h2><span class="hint">AIによる講評(数値は集計値に基づきます)</span></div>
      <p class="summary-text" id="summary-text"></p>
    </section>

    <!-- ④ フォロワー増減の投稿別寄与 -->
    <section class="card avoid-break" id="sec-contrib" hidden>
      <div class="card-head"><h2>フォロワー増加のきっかけ(投稿別)</h2><span class="hint">増えたフォローがどの投稿がきっかけだったかの内訳(目安)</span></div>
      <div class="chart-host" id="chart-contrib"></div>
      <p class="chart-note" id="contrib-note" hidden>「その他」は、この期間の新規フォロー数から各投稿由来のフォローを引いた概算です。投稿別のフォローとアカウント全体のフォロー数はInstagramの集計方法が異なるため、内訳はおおよその目安です。</p>
    </section>

    <!-- ⑤ 投稿パフォーマンス表 -->
    <section class="card avoid-break" id="sec-posts" hidden>
      <div class="card-head"><h2>投稿パフォーマンス</h2><span class="hint" id="posts-hint">この期間の投稿の反応まとめ</span></div>
      <div class="table-wrap"><table id="posts-table" class="posts-table"></table></div>
    </section>

    <!-- ⑥ 推奨投稿時間帯(週報・月報のみ / データ空なら非表示) -->
    <section class="card avoid-break" id="sec-heatmap" hidden>
      <div class="card-head"><h2>おすすめの投稿時間帯</h2><span class="hint">曜日別・時間帯別の平均リーチから計算した目安(色が濃いほどおすすめ)</span></div>
      <div class="chart-host" id="chart-heatmap"></div>
      <p class="heatmap-reco" id="heatmap-reco"></p>
    </section>

    <!-- ⑥-b コンテンツ別パフォーマンス(週報・月報のみ) -->
    <section class="card avoid-break" id="sec-content" hidden>
      <div class="card-head"><h2>コンテンツ別パフォーマンス</h2><span class="hint">平均リーチ・平均フォロー増・件数</span></div>
      <div class="content-tables">
        <div><h3>テーマ別</h3><div class="table-wrap"><table id="content-theme-table"></table></div></div>
        <div><h3>ハッシュタグ別</h3><div class="table-wrap"><table id="content-hashtag-table"></table></div></div>
        <div><h3>キャプションの長さ別</h3><div class="table-wrap"><table id="content-caplen-table"></table></div></div>
      </div>
    </section>

    <!-- ⑥-c フォロワーの属性(週報・月報のみ) -->
    <section class="card avoid-break" id="sec-audience" hidden>
      <div class="card-head"><h2>フォロワーの属性</h2><span class="hint" id="audience-collected"></span></div>
      <div class="audience-grid">
        <div><h3>年齢</h3><div class="chart-host" id="chart-rp-age"></div></div>
        <div><h3>性別</h3><div class="chart-host" id="chart-rp-gender"></div></div>
        <div><h3>都市(トップ5)</h3><div class="table-wrap"><table id="rp-city-table"></table></div></div>
      </div>
    </section>

    <!-- ⑦ 要因と提案(LLM。null時は非表示) -->
    <section class="card avoid-break" id="sec-llm" hidden>
      <div class="card-head"><h2>要因と次のアクション</h2><span class="hint" id="llm-meta"></span></div>
      <div class="llm-cols">
        <div>
          <h3>伸びた・落ちた要因</h3>
          <ul id="llm-factors" class="llm-list"></ul>
        </div>
        <div>
          <h3>次のアクション提案</h3>
          <ul id="llm-actions" class="llm-list"></ul>
        </div>
      </div>
    </section>

    <!-- ⑧ 他アカウント増減サマリ(参考情報なので末尾・2列表示。印刷で溢れる場合はここから2ページ目へ) -->
    <section class="card avoid-break" id="sec-others" hidden>
      <div class="card-head"><h2>ほかのアカウントの増減</h2><span class="hint">参考: 同期間のフォロワー数と増減</span></div>
      <div class="others-grid">
        <div class="table-wrap"><table id="others-table-a"></table></div>
        <div class="table-wrap"><table id="others-table-b"></table></div>
      </div>
    </section>

    <!-- ⑨ 脚注(用語説明) -->
    <section class="card footnotes avoid-break" id="sec-notes">
      <div class="card-head"><h2>ことばの説明</h2></div>
      <dl class="note-list">
        <div><dt>リーチ</dt><dd>投稿を見た「人数」。同じ人が何回見ても1人と数えます。</dd></div>
        <div><dt>ビュー</dt><dd>投稿が表示・再生された「回数」。同じ人が2回見れば2回です。</dd></div>
        <div><dt>いいね率 / 保存率</dt><dd>いいね(保存)の数 ÷ リーチ。見た人のうち何%が反応したかの割合です。</dd></div>
        <div><dt>フォロー(この期間)</dt><dd>その投稿がきっかけで、この期間内に新しくフォローしてくれた人数です。</dd></div>
        <div><dt>平均比</dt><dd>直近30日の投稿の標準的な成績(中央値)と比べて何倍伸びたか。1.0倍=いつも通りです。</dd></div>
        <div><dt>初速</dt><dd>投稿してから1〜48時間でリーチがどれだけ伸びたか。早く伸びる投稿ほど多くの人に届きやすいです。</dd></div>
        <div><dt>おすすめの投稿時間帯</dt><dd>曜日別・時間帯別の平均リーチをかけ合わせて計算した目安です。</dd></div>
        <div><dt>前期間比</dt><dd>ひとつ前の期間(日報なら前日、週報なら前週、月報なら前月)と比べた増減・割合です。</dd></div>
        <div><dt>予測</dt><dd>直近30日の伸び方から計算した「このままいけば」の見込み値です。実際の数値と必ず一致するわけではありません。</dd></div>
        <div><dt>テーマ</dt><dd>投稿内容をAIが「行事・お知らせ・活動報告・日常・その他」に分類したものです。</dd></div>
      </dl>
    </section>
  </article>
</div>

<script>
${JS}
</script>
${SW_REGISTER}
</body>
</html>`;
}

/** プリンタアイコン(theme.ts の icon() には無いため本ファイル内に持つ)。 */
const PRINT_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8V3h10v5"/><path d="M7 17H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-3"/><rect x="7" y="14" width="10" height="7"/></svg>`;

const CSS = `
.report-shell { max-width: 860px; margin: 0 auto; padding: 1.1rem 1.25rem 3rem; padding-bottom: calc(3rem + env(safe-area-inset-bottom)); }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 0.8rem; flex-wrap: wrap; margin-bottom: 1.1rem; }
.brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 800; font-size: 1rem; }
.crumb { color: var(--k-text-subtle); font-weight: 600; font-size: 0.85rem; }
.toolbar-controls { display: flex; gap: 0.55rem; align-items: center; flex-wrap: wrap; }
.toolbar-controls a { text-decoration: none; }
.seg { display: inline-flex; border: 1px solid var(--k-line); border-radius: var(--radius-sm); overflow: hidden; }
.seg button { background: transparent; color: var(--k-text-subtle); border: none; padding: 0.38rem 0.7rem; font-size: 0.84rem; }
.seg button.active { background: var(--k-interactive); color: #fff; font-weight: 700; }
.status-card { color: var(--k-text-subtle); font-size: 0.9rem; }

#report-body { display: flex; flex-direction: column; gap: 0.9rem; }

/* 印刷ヘッダを兼ねるレポート見出し */
.report-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; border-bottom: 2px solid var(--k-text-strong); padding-bottom: 0.55rem; flex-wrap: wrap; }
.report-head h1 { margin: 0 0 0.2rem; font-size: 1.35rem; letter-spacing: 0.01em; }
.rp-meta { display: flex; gap: 0.7rem; flex-wrap: wrap; font-size: 0.9rem; color: var(--k-text-subtle); }
.rp-account { color: var(--k-text); font-weight: 700; }
.rh-brand { display: flex; flex-direction: column; align-items: flex-end; gap: 0.15rem; }
.rh-logo { display: inline-flex; align-items: center; gap: 0.35rem; font-weight: 800; font-size: 0.82rem; }
.rp-created { font-size: 0.7rem; color: var(--k-text-subtle); }

/* KPI行(6枚) */
.kpi-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 0.6rem; }
.kpi { background: var(--k-base); border: 1px solid var(--k-line); border-radius: var(--radius); padding: 0.6rem 0.7rem; min-width: 0; box-shadow: var(--shadow-sm); }
.kpi-label { font-size: 0.68rem; color: var(--k-text-subtle); line-height: 1.3; }
.kpi-value { font-size: 1.18rem; font-weight: 800; line-height: 1.2; margin-top: 0.15rem; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; white-space: nowrap; }
.kpi-value.pos { color: var(--up); }
.kpi-value.neg { color: var(--down); }
.kpi-sub { font-size: 0.68rem; color: var(--k-text-subtle); margin-top: 0.2rem; }
.kpi-sub.pos { color: var(--up); }
.kpi-sub.neg { color: var(--down); }

.forecast-card { padding: 0.7rem 1rem; }
.forecast-line, .forecast-goal { margin: 0; font-size: 0.88rem; line-height: 1.6; }
.forecast-goal { margin-top: 0.25rem; color: var(--k-text-subtle); }
.forecast-line b, .forecast-goal b { color: var(--k-interactive); }

#chart-trend-line, #chart-trend-bar { overflow-x: auto; }
#chart-trend-line svg, #chart-trend-bar svg { min-width: 560px; }

.content-tables, .audience-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.9rem; }
.content-tables h3, .audience-grid h3 { margin: 0 0 0.35rem; font-size: 0.82rem; color: var(--k-text-subtle); font-weight: 700; }
.content-tables table, .rp-city-table { font-size: 0.78rem; }
#rp-city-table th, #rp-city-table td, #content-theme-table th, #content-theme-table td,
#content-hashtag-table th, #content-hashtag-table td, #content-caplen-table th, #content-caplen-table td {
  padding: 0.35rem 0.3rem; white-space: normal; word-break: break-word;
}

.summary-text { margin: 0; font-size: 0.95rem; line-height: 1.8; }

.chart-note { margin: 0.55rem 0 0; font-size: 0.76rem; color: var(--k-text-subtle); line-height: 1.5; }
.heatmap-reco { margin: 0.5rem 0 0; font-size: 0.85rem; }
.heatmap-reco b { color: var(--k-interactive); }

/* 狭い画面ではチャートを縮小せず横スクロールで読めるようにする */
#chart-contrib, #chart-heatmap { overflow-x: auto; }
#chart-contrib svg { min-width: 620px; }
#chart-heatmap svg { min-width: 600px; }

/* 表 */
.posts-table { font-size: 0.78rem; }
.posts-table th, .posts-table td { padding: 0.4rem 0.45rem; }
.posts-table td { vertical-align: middle; }
.posts-table .c-mid { text-align: center; }
.post-cell { display: flex; align-items: center; gap: 0.55rem; min-width: 190px; max-width: 260px; white-space: normal; }
.rp-thumb { width: 44px; height: 44px; flex-shrink: 0; border-radius: 6px; object-fit: cover; background: var(--k-recessed); border: 1px solid var(--k-line); display: block; }
.post-cap { font-size: 0.8rem; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-align: left; }
.post-cap a { text-decoration: none; color: inherit; }
.type-badge { display: inline-block; font-size: 0.68rem; font-weight: 700; border: 1px solid var(--k-line); border-radius: 4px; padding: 0.05rem 0.35rem; color: var(--k-text-subtle); white-space: nowrap; }
.mult-hot { color: var(--up); font-weight: 700; }
.mult-cold { color: var(--down); font-weight: 700; }
.early-cell { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 0.1rem; }
.early-cell small { font-size: 0.68rem; color: var(--k-text-subtle); font-variant-numeric: tabular-nums; }
.pos { color: var(--up); }
.neg { color: var(--down); }
.muted { color: var(--k-text-subtle); }

/* LLM 要因/提案 */
.llm-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.llm-cols h3 { margin: 0 0 0.4rem; font-size: 0.85rem; color: var(--k-text-subtle); font-weight: 700; }
.llm-list { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.88rem; line-height: 1.6; }
/* 他アカウント(2列・コンパクト)。アカウント名は省略表示にして数値列の見切れを防ぐ */
.others-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1.2rem; align-items: start; }
.others-grid table { font-size: 0.78rem; table-layout: fixed; width: 100%; }
.others-grid th, .others-grid td { padding: 0.3rem 0.35rem; }
.others-grid th:nth-child(2), .others-grid td:nth-child(2) { width: 5.2em; }
.others-grid th:nth-child(3), .others-grid td:nth-child(3) { width: 3.6em; }
.others-grid td:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 脚注 */
.footnotes .note-list { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0.45rem 1.2rem; }
.note-list div { display: flex; gap: 0.5rem; align-items: baseline; }
.note-list dt { flex-shrink: 0; font-size: 0.78rem; font-weight: 700; min-width: 7.5em; }
.note-list dd { margin: 0; font-size: 0.78rem; color: var(--k-text-subtle); line-height: 1.5; }

/* SVG 部品(テーマ変数を CSS 経由で参照 → 印刷時のライト強制が効く) */
.sv-text { fill: var(--k-text); }
.sv-muted { fill: var(--k-text-subtle); }
.sv-up { fill: var(--up); }
.sv-down { fill: var(--down); }
.sv-brand { fill: var(--k-brand); }
.sv-axis { stroke: var(--axis); }
.sv-spark { stroke: var(--k-interactive); fill: none; }
.hm-cell { fill: var(--k-interactive); }
.hm-empty { fill: var(--k-recessed); }

@media (max-width: 760px) {
  .kpi-grid { grid-template-columns: repeat(3, 1fr); }
  .llm-cols { grid-template-columns: 1fr; }
  .others-grid { grid-template-columns: 1fr; }
  .footnotes .note-list { grid-template-columns: 1fr; }
  .content-tables, .audience-grid { grid-template-columns: 1fr; }
}
@media (max-width: 430px) {
  .report-shell { padding: 0.8rem 0.8rem 3rem; }
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
  .report-head { align-items: flex-start; }
  .rh-brand { display: none; }
}

/* ---- 印刷(A4縦1枚・常にライト・操作UI非表示・泣き別れ防止) ---- */
@page { size: A4 portrait; margin: 9mm; }
@media print {
  :root {
    /* ダークモード中でも印刷は必ずライト配色に固定する */
    color-scheme: light;
    --k-canvas: #ffffff; --k-elevated: #ffffff; --k-base: #ffffff; --k-recessed: #f4f4f5;
    --k-line: #d4d4d8; --k-line-strong: #a1a1aa;
    --k-text: #18181b; --k-text-strong: #09090b; --k-text-subtle: #52525b; --k-text-inactive: #a1a1aa;
    --k-brand: #f6821f; --k-interactive: #2563eb; --k-interactive-hover: #1d4ed8; --k-link: #1d4ed8;
    --k-success: #047857; --k-success-bg: #ecfdf5; --k-danger: #dc2626; --k-danger-bg: #fef2f2;
    --k-warning: #b45309; --k-warning-bg: #fffbeb;
    --followers: #d55181; --followers-fill: rgba(232,123,164,0.22);
    --up: #0ca30c; --down: #eb6834; --violet: #4a3aa7; --axis: #c3c2b7; --grid: #e7e7ea;
    --shadow-sm: none; --shadow: none;
  }
  html, body { background: #ffffff; }
  /* rem の基準(既定16px)を上げて印刷全体をひと回り大きくする(1ページ維持は実測で調整)。
     講評が長い+投稿表あり等の最悪ケースでは末尾の「他アカウント」だけが2ページ目へ逃げる。 */
  html { font-size: 17px; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 12px; }
  .no-print { display: none !important; }
  /* 「ことばの説明」は1枚に収めるため印刷には含めない(画面では表示) */
  .footnotes { display: none !important; }
  .report-shell { max-width: none; margin: 0; padding: 0; }
  #report-body { gap: 0.45rem; }
  .card { box-shadow: none; border-color: #d4d4d8; padding: 0.55rem 0.7rem; }
  .card-head { margin-bottom: 0.35rem; }
  .card-head h2 { font-size: 0.88rem; }
  .card-head .hint { font-size: 0.66rem; }
  .avoid-break, .kpi, tr { break-inside: avoid; page-break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
  .report-head { padding-bottom: 0.35rem; }
  .report-head h1 { font-size: 1.15rem; }
  .kpi-grid { grid-template-columns: repeat(6, 1fr); gap: 0.4rem; }
  .kpi { padding: 0.42rem 0.5rem; }
  .kpi-value { font-size: 1.05rem; }
  .forecast-card { padding: 0.45rem 0.65rem; }
  .forecast-line, .forecast-goal { font-size: 0.82rem; line-height: 1.5; }
  .summary-text { font-size: 0.88rem; line-height: 1.6; }
  .llm-cols { grid-template-columns: 1fr 1fr; gap: 0.7rem; }
  .llm-list { font-size: 0.82rem; line-height: 1.5; gap: 0.25rem; }
  .content-tables, .audience-grid { grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem; }
  /* フォロワー推移の2チャートは印刷では左右に並べて高さを半分にする
     (:not([hidden]) — display 指定が hidden 属性を上書きしないように) */
  #sec-trend:not([hidden]) { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; align-items: start; }
  #sec-trend .card-head { grid-column: 1 / -1; }
  /* 投稿表を A4 幅(約192mm)に収める(印刷では横スクロールが使えない) */
  .posts-table { font-size: 0.68rem; }
  .posts-table th, .posts-table td { padding: 0.22rem 0.26rem; }
  .post-cell { min-width: 115px; max-width: 165px; }
  .post-cap { -webkit-line-clamp: 1; }
  .rp-thumb { width: 26px; height: 26px; }
  /* 他アカウント増減は2列・コンパクト */
  .others-grid { grid-template-columns: 1fr 1fr; gap: 0 0.8rem; }
  .others-grid table { font-size: 0.68rem; }
  .others-grid th, .others-grid td { padding: 0.16rem 0.3rem; }
  .chart-note { font-size: 0.64rem; margin-top: 0.3rem; }
  .heatmap-reco { font-size: 0.74rem; margin-top: 0.3rem; }
  #chart-contrib, #chart-heatmap, #chart-trend-line, #chart-trend-bar { overflow: visible; }
  .chart-host svg { min-width: 0; width: 100%; height: auto; }
  /* 寄与チャートは横幅を少し絞って高さを抑える */
  #chart-contrib svg { width: 85%; }
}
`;

const JS = `
(function () {
  var SVGNS = 'http://www.w3.org/2000/svg';
  var nf = new Intl.NumberFormat('ja-JP');
  var params = new URLSearchParams(location.search);
  var MOCK = params.get('mock'); // '1'=講評あり / 'nollm'=講評なし(数値のみ)
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];
  var KIND_LABEL = { daily: '日次レポート', weekly: '週次レポート', monthly: '月次レポート' };

  var state = {
    kind: params.get('kind') || 'daily',
    period: params.get('period') || null,
    list: []
  };
  if (!KIND_LABEL[state.kind]) state.kind = 'daily';

  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; });
  }
  function mk(tag, attrs) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) { if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]); } return e; }
  function newSvg(host, w, h) { host.innerHTML = ''; var svg = mk('svg', { viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, preserveAspectRatio: 'xMidYMid meet' }); host.appendChild(svg); return svg; }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function num(v) { return v === null || v === undefined ? '—' : nf.format(v); }
  function pct(v) { return v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%'; }
  function signed(v) { return v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + nf.format(v); }
  function deltaHtml(v) {
    if (v === null || v === undefined) return '<span class="muted">—</span>';
    if (v === 0) return '<span class="muted">±0</span>';
    var up = v > 0;
    return '<span class="' + (up ? 'pos' : 'neg') + '">' + (up ? '▲ +' : '▼ ') + nf.format(v) + '</span>';
  }

  // ---- 日付表示(JST) ----
  var jstDT = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function fmtJst(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16);
    return jstDT.format(d);
  }
  function fmtDateJa(ymd) {
    if (!ymd) return '—';
    var d = new Date(ymd + 'T00:00:00+09:00');
    if (isNaN(d.getTime())) return ymd;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日(' + DOW[d.getDay()] + ')';
  }
  function periodLabel(kind, start, end) {
    if (!start) return '—';
    if (kind === 'daily') return start.slice(0, 4) + '年' + fmtDateJa(start);
    if (kind === 'monthly') return start.slice(0, 4) + '年' + Number(start.slice(5, 7)) + '月';
    return start.slice(0, 4) + '年' + fmtDateJa(start) + ' 〜 ' + fmtDateJa(end || start);
  }
  function typeLabel(t) {
    if (!t) return '—';
    var u = String(t).toUpperCase();
    if (u.indexOf('CAROUSEL') >= 0) return 'カルーセル';
    if (u.indexOf('VIDEO') >= 0 || u.indexOf('REEL') >= 0) return 'リール';
    if (u.indexOf('IMAGE') >= 0) return '画像';
    return t;
  }

  // ---- API(?mock= でモック注入。契約: /ui/reports, /ui/reports/:kind/:period_start) ----
  function fetchList(kind) {
    if (MOCK) return Promise.resolve(mockList(kind));
    return fetch('/ui/reports?kind=' + encodeURIComponent(kind) + '&limit=30')
      .then(function (r) { if (!r.ok) throw new Error('list ' + r.status); return r.json(); })
      .then(function (j) { return j.reports || []; });
  }
  function fetchReport(kind, periodStart) {
    if (MOCK) return Promise.resolve(mockReport(kind, MOCK === 'nollm'));
    return fetch('/ui/reports/' + encodeURIComponent(kind) + '/' + encodeURIComponent(periodStart))
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('report ' + r.status);
        return r.json();
      })
      .then(function (j) { return j && j.report ? j.report : null; });
  }

  function setStatus(msg) {
    var s = el('report-status');
    if (!msg) { s.hidden = true; return; }
    s.textContent = msg; s.hidden = false;
  }

  // ---- 読み込みフロー ----
  function loadList() {
    setStatus('読み込み中...');
    el('report-body').hidden = true;
    fetchList(state.kind).then(function (list) {
      state.list = list;
      var sel = el('period-select'); sel.innerHTML = '';
      if (list.length === 0) { setStatus('この種類のレポートはまだありません。毎朝7時に自動生成されます。'); return; }
      list.forEach(function (it) {
        var o = document.createElement('option');
        o.value = it.period_start;
        o.textContent = periodLabel(state.kind, it.period_start, it.period_end);
        sel.appendChild(o);
      });
      var found = state.period && list.some(function (it) { return it.period_start === state.period; });
      state.period = found ? state.period : list[0].period_start;
      sel.value = state.period;
      loadReport();
    }).catch(function () { setStatus('レポート一覧の取得に失敗しました。時間をおいて再読み込みしてください。'); });
  }

  function loadReport() {
    setStatus('読み込み中...');
    el('report-body').hidden = true;
    syncUrl();
    fetchReport(state.kind, state.period).then(function (report) {
      if (!report) { setStatus('このレポートは見つかりませんでした(404)。'); return; }
      render(report);
      setStatus(null);
      el('report-body').hidden = false;
    }).catch(function () { setStatus('レポートの取得に失敗しました。時間をおいて再読み込みしてください。'); });
  }

  function syncUrl() {
    var q = new URLSearchParams();
    q.set('kind', state.kind);
    if (state.period) q.set('period', state.period);
    if (MOCK) q.set('mock', MOCK);
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }

  function parseMaybeJson(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
    return v;
  }

  // ---- 描画 ----
  function render(report) {
    var metrics = parseMaybeJson(report.metrics) || {};
    var llm = parseMaybeJson(report.llm);
    var kpi = metrics.kpi || {};
    var kindLabel = KIND_LABEL[report.kind] || 'レポート';
    var pl = periodLabel(report.kind, report.period_start, report.period_end);

    el('rp-title').textContent = kindLabel;
    el('rp-account').textContent = '@' + (report.handle || '—');
    el('rp-period').textContent = '対象期間: ' + pl;
    el('rp-created').textContent = report.created_at ? '作成: ' + fmtJst(report.created_at) : '';
    document.title = kindLabel + ' ' + (report.period_start || '') + ' @' + (report.handle || '') + ' — SCTracker';
    // PDF保存時のファイル名(=印刷中の document.title)。記号を避けた名前にする
    state.pdfName = kindLabel + '_' + (report.period_start || '') + '_' + (report.handle || '');

    renderKpis(kpi, metrics.compare);
    renderForecast(metrics.forecast);
    renderTrend(report.kind, metrics.trend);
    renderSummary(llm);
    renderContrib(metrics.contributions || [], kpi);
    renderPosts(mergePosts(report.kind, metrics));
    renderHeatmap(report.kind, metrics.cross || {});
    renderContentAnalysis(report.kind, metrics.cross || {});
    renderAudienceSection(report.kind, metrics.audience);
    renderOthers(metrics.others || []);
    renderLlm(llm);
  }

  // ---- compare(前期間比)のサブ行 ----
  function compareSubHtml(compare, key) {
    if (!compare || !compare.prev || compare.prev[key] === undefined || compare.prev[key] === null) return '';
    var prevVal = compare.prev[key];
    var pctVal = compare.pct ? compare.pct[key] : null;
    var cls = '', pctTxt = '';
    if (pctVal !== null && pctVal !== undefined) {
      var up = pctVal >= 0;
      cls = up ? 'pos' : 'neg';
      pctTxt = ' (' + (up ? '+' : '') + (pctVal * 100).toFixed(1) + '%)';
    }
    return '<div class="kpi-sub ' + cls + '">前期間: ' + nf.format(prevVal) + pctTxt + '</div>';
  }

  function renderKpis(kpi, compare) {
    var tiles = [
      { label: 'フォロワー(合計)', value: num(kpi.followers), key: 'followers' },
      { label: '増減(この期間)', value: signed(kpi.delta), cls: kpi.delta > 0 ? 'pos' : kpi.delta < 0 ? 'neg' : '', key: 'delta' },
      { label: 'リーチ(見た人の数)', value: num(kpi.reach), key: 'reach' },
      { label: 'ビュー(見られた回数)', value: num(kpi.views), key: 'views' },
      { label: '新規フォロー', value: num(kpi.follows_gained), cls: kpi.follows_gained > 0 ? 'pos' : '', key: 'follows_gained' },
      { label: 'フォロー解除', value: num(kpi.follows_lost), cls: kpi.follows_lost > 0 ? 'neg' : '', key: 'follows_lost' }
    ];
    var grid = el('kpi-grid'); grid.innerHTML = '';
    tiles.forEach(function (t) {
      var div = document.createElement('div'); div.className = 'kpi';
      div.innerHTML = '<div class="kpi-label">' + t.label + '</div><div class="kpi-value ' + (t.cls || '') + '">' + t.value + '</div>' + compareSubHtml(compare, t.key);
      grid.appendChild(div);
    });
  }

  // ②-b 予測(forecast)
  function renderForecast(forecast) {
    var sec = el('sec-forecast');
    if (!forecast || !forecast.month_end) { sec.hidden = true; return; }
    sec.hidden = false;
    var me = forecast.month_end;
    el('forecast-line').innerHTML = 'この調子なら <b>' + fmtDateJa(me.date) + '</b> に約 <b>' + nf.format(me.followers) + '人</b>' +
      (forecast.daily_pace != null ? '(1日あたり約 ' + Number(forecast.daily_pace).toFixed(1) + '人ペース)' : '');
    var goalEl = el('forecast-goal');
    if (forecast.goal == null) { goalEl.hidden = true; return; }
    goalEl.hidden = false;
    if (forecast.goal_achieved) {
      goalEl.innerHTML = '目標 <b>' + nf.format(forecast.goal) + '人</b>はすでに達成しています🎉';
    } else if (forecast.goal_eta) {
      goalEl.innerHTML = '目標 <b>' + nf.format(forecast.goal) + '人</b>には <b>' + fmtDateJa(forecast.goal_eta) + '</b> 頃に到達見込みです。';
    } else {
      goalEl.innerHTML = '目標 <b>' + nf.format(forecast.goal) + '人</b>には、このペースでは到達見込みが立ちません。';
    }
  }

  // ②-c トレンド(直近12期間。フォロワー数の折れ線 + 純増減の棒)
  function renderTrend(kind, trend) {
    var sec = el('sec-trend');
    if (kind === 'daily' || !trend || trend.length === 0) { sec.hidden = true; return; }
    sec.hidden = false;

    // 折れ線(フォロワー数)
    (function () {
      var W = 700, H = 160, mL = 48, mR = 14, mT = 12, mB = 22;
      var svg = newSvg(el('chart-trend-line'), W, H);
      var vals = trend.map(function (t) { return t.followers; });
      var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
      var pad = Math.max(1, (maxV - minV) * 0.15); minV -= pad; maxV += pad; if (minV === maxV) { minV -= 1; maxV += 1; }
      var n = trend.length, pw = W - mL - mR, ph = H - mT - mB;
      function x(i) { return mL + (n === 1 ? pw / 2 : (i / (n - 1)) * pw); }
      function y(v) { return mT + ph - ((v - minV) / (maxV - minV)) * ph; }
      var d = ''; trend.forEach(function (t, i) { d += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(t.followers).toFixed(1) + ' '; });
      svg.appendChild(mk('path', { d: d, 'class': 'sv-spark', 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      trend.forEach(function (t, i) {
        svg.appendChild(mk('circle', { cx: x(i), cy: y(t.followers), r: 2.5, 'class': 'sv-brand' }));
        var lbl = mk('text', { x: x(i), y: y(t.followers) - 7, 'font-size': 9, 'class': 'sv-text', 'text-anchor': 'middle' });
        lbl.textContent = nf.format(t.followers); svg.appendChild(lbl);
        var xl = mk('text', { x: x(i), y: mT + ph + 15, 'font-size': 9, 'class': 'sv-muted', 'text-anchor': 'middle' });
        xl.textContent = fmtShortDate(t.period_start); svg.appendChild(xl);
      });
    })();

    // 棒(純増減)
    (function () {
      var W = 700, H = 140, mL = 48, mR = 14, mT = 10, mB = 22;
      var svg = newSvg(el('chart-trend-bar'), W, H);
      var nets = trend.map(function (t) { return t.delta; });
      var maxV = Math.max.apply(null, nets.concat([0])), minV = Math.min.apply(null, nets.concat([0]));
      if (maxV === minV) { maxV += 1; minV -= 1; }
      var span = maxV - minV; maxV += span * 0.1; minV -= span * 0.1;
      var n = trend.length, pw = W - mL - mR, ph = H - mT - mB;
      function y(v) { return mT + ph - ((v - minV) / (maxV - minV)) * ph; }
      var y0 = y(0), slot = pw / n, bw = Math.max(2, Math.min(slot - 6, 26));
      svg.appendChild(mk('line', { x1: mL, x2: W - mR, y1: y0, y2: y0, 'class': 'sv-axis', 'stroke-width': 1 }));
      trend.forEach(function (t, i) {
        var cx = mL + slot * i + slot / 2, up = t.delta >= 0, yv = y(t.delta), top = up ? yv : y0, hgt = Math.max(1, Math.abs(yv - y0));
        svg.appendChild(mk('rect', { x: cx - bw / 2, y: top, width: bw, height: hgt, rx: 3, 'class': up ? 'sv-up' : 'sv-down' }));
        var vl = mk('text', { x: cx, y: up ? top - 4 : top + hgt + 11, 'font-size': 9, 'class': up ? 'sv-up' : 'sv-down', 'text-anchor': 'middle' });
        vl.textContent = (t.delta > 0 ? '+' : '') + nf.format(t.delta); svg.appendChild(vl);
      });
    })();
  }
  function fmtShortDate(ymd) {
    if (!ymd) return '';
    if (ymd.length === 7) return ymd.replace('-', '/');
    var d = new Date(ymd + 'T00:00:00+09:00');
    if (isNaN(d.getTime())) return ymd;
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function renderSummary(llm) {
    var has = llm && llm.summary;
    el('sec-summary').hidden = !has;
    if (has) el('summary-text').textContent = llm.summary;
  }

  // ④ 横棒: 各投稿の寄与 + 残差「その他」。値は常時表示。
  function renderContrib(contribs, kpi) {
    var rows = contribs.map(function (c) {
      return { name: trunc(c.caption_head || c.external_id || '(キャプションなし)', 18) + '(' + typeLabel(c.media_type) + ')', value: c.follows_delta == null ? 0 : c.follows_delta };
    });
    var sum = rows.reduce(function (a, r) { return a + r.value; }, 0);
    var hasOther = kpi.follows_gained != null && kpi.follows_gained - sum > 0;
    if (hasOther) {
      rows.push({ name: 'その他(発見タブ・プロフィール経由など)', value: kpi.follows_gained - sum, other: true });
    }
    el('contrib-note').hidden = !hasOther;
    var sec = el('sec-contrib');
    if (rows.length === 0) { sec.hidden = true; return; }
    sec.hidden = false;

    var W = 760, rowH = 30, mT = 6, mB = 6, labelW = 250, valW = 56;
    var H = mT + mB + rows.length * rowH;
    var svg = newSvg(el('chart-contrib'), W, H);
    var vals = rows.map(function (r) { return r.value; });
    var lo = Math.min(0, Math.min.apply(null, vals));
    var hi = Math.max(0, Math.max.apply(null, vals));
    if (hi === lo) hi = lo + 1;
    var plotL = labelW, plotR = W - valW, plotW = plotR - plotL;
    function bx(v) { return plotL + ((v - lo) / (hi - lo)) * plotW; }
    var zx = bx(0);
    svg.appendChild(mk('line', { x1: zx, x2: zx, y1: mT, y2: H - mB, 'class': 'sv-axis', 'stroke-width': 1 }));
    rows.forEach(function (r, i) {
      var cy = mT + i * rowH + rowH / 2, up = r.value >= 0, x2 = bx(r.value);
      var barCls = r.other ? 'sv-muted' : (up ? 'sv-up' : 'sv-down');
      svg.appendChild(mk('rect', { x: Math.min(zx, x2), y: cy - 8, width: Math.max(1, Math.abs(x2 - zx)), height: 16, rx: 3, 'class': barCls, 'fill-opacity': r.other ? 0.6 : 1 }));
      var nm = mk('text', { x: labelW - 8, y: cy + 4, 'font-size': 11, 'class': 'sv-text', 'text-anchor': 'end' });
      nm.textContent = r.name; svg.appendChild(nm);
      // 値は常時表示(印刷でも読めるように右端の固定カラムへ)
      var vl = mk('text', { x: W - 4, y: cy + 4, 'font-size': 11, 'font-weight': 700, 'class': r.other ? 'sv-muted' : (up ? 'sv-up' : 'sv-down'), 'text-anchor': 'end' });
      vl.textContent = (r.value > 0 ? '+' : '') + nf.format(r.value) + '人'; svg.appendChild(vl);
    });
  }

  // ⑤ 投稿表(サムネ・形式・投稿時刻JST・リーチ・いいね率・保存率・フォロー・平均比・初速)
  var THUMB_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" viewBox="0 0 88 88"><rect width="88" height="88" fill="#e4e4e7"/><path d="M26 58l14-14 9 9 7-7 12 12" fill="none" stroke="#a1a1aa" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="33" cy="32" r="5" fill="#a1a1aa"/></svg>');
  function earlyCellHtml(early) {
    if (!early) return '<span class="muted">—</span>';
    var pts = [['1h', early.h1], ['3h', early.h3], ['6h', early.h6], ['24h', early.h24], ['48h', early.h48]]
      .filter(function (p) { return p[1] !== null && p[1] !== undefined; });
    if (pts.length === 0) return '<span class="muted">—</span>';
    var last = pts[pts.length - 1];
    var w = 64, h = 16, pad = 2;
    var vals = pts.map(function (p) { return p[1]; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min === max) { min -= 1; max += 1; }
    var d = '';
    pts.forEach(function (p, i) {
      var x = pts.length === 1 ? w / 2 : pad + (i / (pts.length - 1)) * (w - 2 * pad);
      var y = h - pad - ((p[1] - min) / (max - min)) * (h - 2 * pad);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    });
    var svg = pts.length > 1
      ? '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path class="sv-spark" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="' + d.trim() + '"/></svg>'
      : '';
    return '<span class="early-cell">' + svg + '<small>' + last[0] + 'で ' + nf.format(last[1]) + '</small></span>';
  }
  function multipleHtml(m) {
    if (m === null || m === undefined) return '<span class="muted">—</span>';
    var txt = Number(m).toFixed(1) + '倍';
    if (m >= 1.5) return '<span class="mult-hot">' + txt + '</span>';
    if (m < 0.7) return '<span class="mult-cold">' + txt + '</span>';
    return txt;
  }
  // 日報は期間内投稿だけだと0件になりがちなので、直近投稿(metrics.recent_posts)を
  // マージして表示する(post_id で重複除外・新しい順)。講評の入力には含めない。
  function mergePosts(kind, metrics) {
    var base = metrics.posts || [];
    if (kind !== 'daily') return base;
    var recent = metrics.recent_posts || [];
    if (recent.length) el('posts-hint').textContent = '直近の投稿を含む(投稿時刻を参照)';
    var seen = {};
    base.forEach(function (p) { seen[p.post_id] = true; });
    var merged = base.concat(recent.filter(function (p) { return !seen[p.post_id]; }));
    merged.sort(function (a, b) { return (b.posted_at || '').localeCompare(a.posted_at || ''); });
    return merged;
  }

  function renderPosts(posts) {
    var sec = el('sec-posts');
    if (posts.length === 0) { sec.hidden = true; return; }
    sec.hidden = false;
    var head = '<thead><tr><th>投稿</th><th class="c-mid">形式</th><th class="c-mid">投稿時刻</th><th>リーチ</th><th>いいね率</th><th>保存率</th><th>フォロー(この期間)</th><th>平均比</th><th>初速</th></tr></thead>';
    var body = posts.map(function (p) {
      var pid = p.post_id;
      var src = pid ? '/img/' + pid : THUMB_PLACEHOLDER;
      var cap = escapeHtml(trunc(p.caption_head || '(キャプションなし)', 44));
      var capHtml = p.url ? '<a href="' + encodeURI(p.url) + '" target="_blank" rel="noreferrer">' + cap + '</a>' : cap;
      return '<tr>' +
        '<td><span class="post-cell"><img class="rp-thumb" loading="lazy" alt="" src="' + src + '" /><span class="post-cap">' + capHtml + '</span></span></td>' +
        '<td class="c-mid"><span class="type-badge">' + escapeHtml(typeLabel(p.media_type)) + '</span></td>' +
        '<td class="c-mid">' + fmtJst(p.posted_at) + '</td>' +
        '<td>' + num(p.reach) + '</td>' +
        '<td>' + pct(p.like_rate) + '</td>' +
        '<td>' + pct(p.save_rate) + '</td>' +
        '<td>' + (p.follows_delta == null ? '<span class="muted">—</span>' : num(p.follows_delta)) + '</td>' +
        '<td>' + multipleHtml(p.baseline_multiple) + '</td>' +
        '<td>' + earlyCellHtml(p.early) + '</td>' +
        '</tr>';
    }).join('');
    el('posts-table').innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  // ⑥ ヒートマップ(週報・月報のみ)。by_dow×by_hour の周辺分布(平均リーチ)を正規化して
  //   かけ合わせた「推奨度」を色の濃さで示す(セル単位の実測クロス値はAPIに無いため)。
  function renderHeatmap(kind, cross) {
    var sec = el('sec-heatmap');
    var byDow = cross.by_dow || [], byHour = cross.by_hour || [];
    if (kind === 'daily' || byDow.length === 0 || byHour.length === 0) { sec.hidden = true; return; }

    function metricOf(r) {
      var v = r.avg_reach;
      if (v === null || v === undefined || v === 0) v = r.avg_follows;
      return v === null || v === undefined ? null : v;
    }
    var dowVals = [], hourVals = [];
    for (var i = 0; i < 7; i++) dowVals.push(null);
    for (var j = 0; j < 24; j++) hourVals.push(null);
    byDow.forEach(function (r) { if (r.dow >= 0 && r.dow <= 6) dowVals[r.dow] = metricOf(r); });
    byHour.forEach(function (r) { var h = r.hour !== undefined ? r.hour : r.h; if (h >= 0 && h <= 23) hourVals[h] = metricOf(r); });
    var dMax = Math.max.apply(null, dowVals.map(function (v) { return v || 0; }));
    var hMax = Math.max.apply(null, hourVals.map(function (v) { return v || 0; }));
    if (dMax <= 0 || hMax <= 0) { sec.hidden = true; return; }
    sec.hidden = false;

    var cw = 26, ch = 20, gap = 2, mL = 34, mT = 16;
    var W = mL + 24 * (cw + gap), H = mT + 7 * (ch + gap);
    var svg = newSvg(el('chart-heatmap'), W, H);
    for (var hh = 0; hh < 24; hh += 3) {
      var tl = mk('text', { x: mL + hh * (cw + gap) + cw / 2, y: mT - 5, 'font-size': 9, 'class': 'sv-muted', 'text-anchor': 'middle' });
      tl.textContent = hh + '時'; svg.appendChild(tl);
    }
    var scores = [];
    for (var d = 0; d < 7; d++) {
      var dl = mk('text', { x: mL - 8, y: mT + d * (ch + gap) + ch / 2 + 3, 'font-size': 10, 'class': 'sv-text', 'text-anchor': 'end' });
      dl.textContent = DOW[d]; svg.appendChild(dl);
      for (var h = 0; h < 24; h++) {
        var x = mL + h * (cw + gap), y = mT + d * (ch + gap);
        var hasData = dowVals[d] !== null && hourVals[h] !== null;
        if (!hasData) {
          svg.appendChild(mk('rect', { x: x, y: y, width: cw, height: ch, rx: 3, 'class': 'hm-empty' }));
          continue;
        }
        var score = (dowVals[d] / dMax) * (hourVals[h] / hMax);
        scores.push({ d: d, h: h, score: score });
        svg.appendChild(mk('rect', { x: x, y: y, width: cw, height: ch, rx: 3, 'class': 'hm-cell', 'fill-opacity': (0.07 + 0.9 * score).toFixed(3) }));
      }
    }
    scores.sort(function (a, b) { return b.score - a.score; });
    var top = scores.slice(0, 3).map(function (s) { return '<b>' + DOW[s.d] + '曜 ' + s.h + '時ごろ</b>'; });
    el('heatmap-reco').innerHTML = top.length ? 'おすすめ: ' + top.join(' / ') : '';
  }

  // ⑥-b コンテンツ別パフォーマンス(テーマ/ハッシュタグ/キャプション長)。週報・月報のみ。
  var CAPLEN_LABEL = { short: '短い(〜99字)', medium: '普通(100〜300字)', long: '長い(301字〜)' };
  function contentTableHtml(rows, nameKey, nameFmt) {
    if (!rows || rows.length === 0) return '<tbody><tr><td colspan="4" class="muted">データがありません</td></tr></tbody>';
    var head = '<thead><tr><th>' + (nameKey === 'theme' ? 'テーマ' : nameKey === 'hashtag' ? 'ハッシュタグ' : '長さ') + '</th><th>リーチ</th><th>フォロー</th><th>件数</th></tr></thead>';
    var body = rows.map(function (r) {
      var name = nameFmt ? nameFmt(r[nameKey]) : escapeHtml(r[nameKey] == null ? '未分類' : String(r[nameKey]));
      return '<tr><td>' + name + '</td><td>' + num(r.avg_reach) + '</td><td>' + num(r.avg_follows) + '</td><td>' + num(r.count) + '</td></tr>';
    }).join('');
    return head + '<tbody>' + body + '</tbody>';
  }
  function renderContentAnalysis(kind, cross) {
    var sec = el('sec-content');
    var byTheme = cross.by_theme || [], byHashtag = cross.by_hashtag || [], byCapLen = cross.by_caption_length || [];
    if (kind === 'daily' || (byTheme.length === 0 && byHashtag.length === 0 && byCapLen.length === 0)) { sec.hidden = true; return; }
    sec.hidden = false;
    el('content-theme-table').innerHTML = contentTableHtml(byTheme, 'theme');
    el('content-hashtag-table').innerHTML = contentTableHtml(byHashtag, 'hashtag', function (h) { return escapeHtml('#' + h); });
    el('content-caplen-table').innerHTML = contentTableHtml(byCapLen, 'bucket', function (b) { return escapeHtml(CAPLEN_LABEL[b] || b); });
  }

  // ⑥-c フォロワーの属性(週報・月報のみ)
  var RP_GENDER_LABEL = { F: '女性', M: '男性', U: '不明' };
  function rpHBar(hostId, rows, suffix) {
    var host = el(hostId);
    var W = 320, rowH = 26, mT = 6, mB = 6, labelW = 64, valW = 56;
    var H = mT + mB + Math.max(1, rows.length) * rowH;
    var svg = newSvg(host, W, H);
    if (rows.length === 0) { return; }
    var maxV = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    var plotL = labelW, plotR = W - valW, plotW = plotR - plotL;
    rows.forEach(function (r, i) {
      var cy = mT + i * rowH + rowH / 2;
      var bw = maxV > 0 ? Math.max(1, (r.value / maxV) * plotW) : 1;
      svg.appendChild(mk('rect', { x: plotL, y: cy - 8, width: bw, height: 16, rx: 3, 'class': 'sv-brand' }));
      var nm = mk('text', { x: labelW - 6, y: cy + 4, 'font-size': 10, 'class': 'sv-text', 'text-anchor': 'end' });
      nm.textContent = r.label; svg.appendChild(nm);
      var vl = mk('text', { x: plotL + bw + 5, y: cy + 4, 'font-size': 10, 'font-weight': 700, 'class': 'sv-text', 'text-anchor': 'start' });
      vl.textContent = nf.format(r.value) + (suffix || ''); svg.appendChild(vl);
    });
  }
  function renderAudienceSection(kind, audience) {
    var sec = el('sec-audience');
    var kinds = audience && audience.kinds;
    var hasData = !!audience && !!audience.collected_at && kinds && Object.keys(kinds).some(function (k) { return (kinds[k] || []).length > 0; });
    if (kind === 'daily' || !hasData) { sec.hidden = true; return; }
    sec.hidden = false;
    el('audience-collected').textContent = '取得日: ' + fmtJst(audience.collected_at);
    rpHBar('chart-rp-age', (kinds.demographics_age || []).map(function (r) { return { label: r.bucket + '歳', value: r.value }; }), '人');
    rpHBar('chart-rp-gender', (kinds.demographics_gender || []).map(function (r) { return { label: RP_GENDER_LABEL[r.bucket] || r.bucket, value: r.value }; }), '人');
    var cities = (kinds.demographics_city || []).slice(0, 5);
    var total = cities.reduce(function (a, r) { return a + r.value; }, 0);
    var head = '<thead><tr><th>都市</th><th>人数</th><th>割合</th></tr></thead>';
    var body = cities.length
      ? cities.map(function (r) { return '<tr><td>' + escapeHtml(r.bucket) + '</td><td>' + nf.format(r.value) + '</td><td>' + (total > 0 ? ((r.value / total) * 100).toFixed(1) + '%' : '—') + '</td></tr>'; }).join('')
      : '<tr><td colspan="3" class="muted">データがありません</td></tr>';
    el('rp-city-table').innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  // ⑦ 他アカウント(2列に分割してコンパクトに表示)
  function renderOthers(others) {
    var sec = el('sec-others');
    if (others.length === 0) { sec.hidden = true; return; }
    sec.hidden = false;
    var head = '<thead><tr><th>アカウント</th><th>フォロワー</th><th>増減</th></tr></thead>';
    function rowsHtml(list) {
      return list.map(function (o) {
        var name = o.display_name ? escapeHtml(o.display_name) + ' <span class="muted">@' + escapeHtml(o.handle || '') + '</span>' : '@' + escapeHtml(o.handle || '—');
        return '<tr><td>' + name + '</td><td>' + num(o.followers) + '</td><td>' + deltaHtml(o.delta) + '</td></tr>';
      }).join('');
    }
    var half = Math.ceil(others.length / 2);
    var left = others.slice(0, half);
    var right = others.slice(half);
    el('others-table-a').innerHTML = head + '<tbody>' + rowsHtml(left) + '</tbody>';
    el('others-table-b').innerHTML = right.length ? head + '<tbody>' + rowsHtml(right) + '</tbody>' : '';
  }

  // ⑧ 要因と提案
  function renderLlm(llm) {
    var has = llm && ((llm.factors && llm.factors.length) || (llm.actions && llm.actions.length));
    el('sec-llm').hidden = !has;
    if (!has) return;
    function fill(id, items) {
      var ul = el(id); ul.innerHTML = '';
      (items || []).forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      ul.parentElement.style.display = items && items.length ? '' : 'none';
    }
    fill('llm-factors', llm.factors);
    fill('llm-actions', llm.actions);
    el('llm-meta').textContent = 'AIによる分析' + (llm.model ? '(' + llm.model + ')' : '') + (llm.generated_at ? ' — ' + fmtJst(llm.generated_at) + ' 生成' : '');
  }

  // ---- 操作 ----
  el('kind-tabs').addEventListener('click', function (e) {
    var k = e.target && e.target.dataset ? e.target.dataset.kind : null;
    if (!k || k === state.kind) return;
    state.kind = k; state.period = null;
    this.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.dataset.kind === k); });
    loadList();
  });
  el('period-select').addEventListener('change', function () { state.period = this.value; loadReport(); });
  el('print-btn').addEventListener('click', function () { window.print(); });

  // 「PDFとして保存」のファイル名はブラウザが document.title から付けるため、
  // 印刷中だけ「日次レポート_2026-07-16_handle」形式に差し替える(Ctrl+P にも効く)。
  window.addEventListener('beforeprint', function () {
    if (!state.pdfName) return;
    state.titleBackup = document.title;
    document.title = state.pdfName;
  });
  window.addEventListener('afterprint', function () {
    if (state.titleBackup) { document.title = state.titleBackup; state.titleBackup = null; }
  });

  document.querySelectorAll('#kind-tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.kind === state.kind); });

  // ---- モックデータ(API未デプロイ時の表示検証用。契約 metrics_json / llm_json 準拠) ----
  function mockPeriod(kind, back) {
    if (kind === 'daily') {
      var days = ['2026-07-11', '2026-07-10', '2026-07-09'];
      return { start: days[back], end: days[back] };
    }
    if (kind === 'weekly') {
      var weeks = [['2026-07-06', '2026-07-12'], ['2026-06-29', '2026-07-05'], ['2026-06-22', '2026-06-28']];
      return { start: weeks[back][0], end: weeks[back][1] };
    }
    var months = [['2026-06-01', '2026-06-30'], ['2026-05-01', '2026-05-31'], ['2026-04-01', '2026-04-30']];
    return { start: months[back][0], end: months[back][1] };
  }
  function mockList(kind) {
    var out = [];
    for (var i = 0; i < 3; i++) {
      var p = mockPeriod(kind, i);
      out.push({ kind: kind, period_start: p.start, period_end: p.end, account_id: 1, handle: 'example_account', created_at: '2026-07-12T07:00:12+09:00' });
    }
    return out;
  }
  function mockReport(kind, noLlm) {
    var p = mockPeriod(kind, Math.max(0, state.list.map(function (it) { return it.period_start; }).indexOf(state.period)));
    var metrics = {
      period: { kind: kind, start: p.start, end: p.end },
      kpi: { followers: 128, delta: 6, reach: 1543, views: 3120, follows_gained: 7, follows_lost: 1, accounts_engaged: 118, total_interactions: 214 },
      contributions: [
        { external_id: 'DLxA1', post_id: 101, caption_head: '【体育祭】応援合戦のハイライトをお届け!', media_type: 'VIDEO', follows_delta: 3 },
        { external_id: 'DLxA2', post_id: 102, caption_head: '生徒総会のお知らせ(6/20 体育館)', media_type: 'IMAGE', follows_delta: 1 },
        { external_id: 'DLxA3', post_id: 103, caption_head: '文化祭まであと30日!準備の様子', media_type: 'CAROUSEL_ALBUM', follows_delta: 1 }
      ],
      posts: [
        { external_id: 'DLxA1', post_id: 101, url: 'https://www.instagram.com/p/DLxA1/', posted_at: '2026-07-07T10:00:00Z', media_type: 'VIDEO', caption_head: '【体育祭】応援合戦のハイライトをお届け!', reach: 2100, likes: 182, comments: 12, saved: 34, shares: 21, follows: null, follows_delta: 3, profile_visits: null, views: 3050, avg_watch_time_ms: 8600, like_rate: 0.0867, save_rate: 0.0162, share_rate: 0.01, baseline_multiple: 3.1, early: { h1: 320, h3: 760, h6: 1150, h24: 1890, h48: 2100 } },
        { external_id: 'DLxA2', post_id: 102, caption_head: '生徒総会のお知らせ(6/20 体育館)', url: 'https://www.instagram.com/p/DLxA2/', posted_at: '2026-07-09T09:05:00Z', media_type: 'IMAGE', reach: 820, likes: 96, comments: 4, saved: 21, shares: 6, follows: 3, follows_delta: 1, profile_visits: 18, views: null, avg_watch_time_ms: null, like_rate: 0.117, save_rate: 0.0256, share_rate: 0.0073, baseline_multiple: 1.8, early: { h1: 120, h3: 260, h6: 410, h24: 780, h48: 820 } },
        { external_id: 'DLxA3', post_id: 103, caption_head: '文化祭まであと30日!準備の様子をちょっとだけ', url: 'https://www.instagram.com/p/DLxA3/', posted_at: '2026-07-08T03:30:00Z', media_type: 'CAROUSEL_ALBUM', reach: 640, likes: 71, comments: 2, saved: 15, shares: 3, follows: 1, follows_delta: 1, profile_visits: 9, views: null, avg_watch_time_ms: null, like_rate: 0.1109, save_rate: 0.0234, share_rate: 0.0047, baseline_multiple: 1.2, early: { h1: null, h3: 180, h6: 260, h24: 520, h48: 640 } },
        { external_id: 'DLxA4', post_id: 104, caption_head: '朝のあいさつ運動、今週も実施中です', url: 'https://www.instagram.com/p/DLxA4/', posted_at: '2026-07-04T23:15:00Z', media_type: 'IMAGE', reach: 310, likes: 28, comments: 0, saved: 3, shares: 1, follows: 0, follows_delta: 0, profile_visits: 4, views: null, avg_watch_time_ms: null, like_rate: 0.0903, save_rate: 0.0097, share_rate: 0.0032, baseline_multiple: 0.6, early: { h1: null, h3: null, h6: null, h24: null, h48: null } },
        { external_id: 'DLxA5', post_id: 105, caption_head: 'クラスマッチの結果発表!優勝は…', url: 'https://www.instagram.com/p/DLxA5/', posted_at: '2026-07-02T08:40:00Z', media_type: 'CAROUSEL_ALBUM', reach: 505, likes: 55, comments: 6, saved: 8, shares: 2, follows: 2, follows_delta: 2, profile_visits: 11, views: null, avg_watch_time_ms: null, like_rate: 0.1089, save_rate: 0.0158, share_rate: 0.004, baseline_multiple: null, early: null }
      ],
      cross: {
        by_dow: [
          { dow: 0, avg_reach: 420, avg_follows: 0.8, count: 3 }, { dow: 1, avg_reach: 510, avg_follows: 1.1, count: 4 },
          { dow: 2, avg_reach: 630, avg_follows: 1.4, count: 4 }, { dow: 3, avg_reach: 380, avg_follows: 0.6, count: 3 },
          { dow: 4, avg_reach: 720, avg_follows: 1.7, count: 5 }, { dow: 5, avg_reach: 980, avg_follows: 2.3, count: 6 },
          { dow: 6, avg_reach: 540, avg_follows: 1.0, count: 3 }
        ],
        by_hour: [
          { hour: 7, avg_reach: 380, avg_follows: 0.7, count: 3 }, { hour: 8, avg_reach: 450, avg_follows: 0.9, count: 4 },
          { hour: 12, avg_reach: 620, avg_follows: 1.3, count: 5 }, { hour: 15, avg_reach: 400, avg_follows: 0.8, count: 2 },
          { hour: 17, avg_reach: 760, avg_follows: 1.8, count: 4 }, { hour: 18, avg_reach: 940, avg_follows: 2.4, count: 6 },
          { hour: 19, avg_reach: 880, avg_follows: 2.1, count: 4 }, { hour: 21, avg_reach: 560, avg_follows: 1.2, count: 2 }
        ],
        by_type: [
          { media_type: 'IMAGE', avg_reach: 520, avg_follows: 1.1, count: 9 },
          { media_type: 'CAROUSEL_ALBUM', avg_reach: 580, avg_follows: 1.3, count: 7 },
          { media_type: 'VIDEO', avg_reach: 1400, avg_follows: 2.2, count: 4 }
        ],
        by_theme: kind === 'daily' ? [] : [
          { theme: '行事', avg_reach: 1250, avg_follows: 2.4, count: 6 },
          { theme: 'お知らせ', avg_reach: 640, avg_follows: 1.1, count: 8 },
          { theme: '活動報告', avg_reach: 580, avg_follows: 0.9, count: 10 },
          { theme: '日常', avg_reach: 340, avg_follows: 0.4, count: 5 },
          { theme: '未分類', avg_reach: 410, avg_follows: 0.6, count: 2 }
        ],
        by_hashtag: kind === 'daily' ? [] : [
          { hashtag: '文化祭', avg_reach: 1380, avg_follows: 2.6, count: 4 },
          { hashtag: '体育祭', avg_reach: 1210, avg_follows: 2.2, count: 3 },
          { hashtag: '生徒会', avg_reach: 590, avg_follows: 0.9, count: 12 },
          { hashtag: 'お知らせ', avg_reach: 520, avg_follows: 0.7, count: 9 }
        ],
        by_caption_length: kind === 'daily' ? [] : [
          { bucket: 'short', avg_reach: 460, avg_follows: 0.7, count: 9 },
          { bucket: 'medium', avg_reach: 720, avg_follows: 1.4, count: 12 },
          { bucket: 'long', avg_reach: 890, avg_follows: 1.8, count: 6 }
        ]
      },
      compare: {
        prev: { followers: kind === 'daily' ? 122 : 96, delta: kind === 'daily' ? 3 : -2, reach: 1320, views: 2850, follows_gained: 5, follows_lost: 2, accounts_engaged: 102, total_interactions: 188 },
        pct: { followers: 0.0492, reach: 0.169, views: 0.0947, follows_gained: 0.4 }
      },
      trend: kind === 'daily' ? null : [
        { period_start: '2026-04-20', followers: 78, delta: 4 }, { period_start: '2026-04-27', followers: 82, delta: 4 },
        { period_start: '2026-05-04', followers: 85, delta: 3 }, { period_start: '2026-05-11', followers: 89, delta: 4 },
        { period_start: '2026-05-18', followers: 90, delta: 1 }, { period_start: '2026-05-25', followers: 96, delta: 6 },
        { period_start: '2026-06-01', followers: 99, delta: 3 }, { period_start: '2026-06-08', followers: 104, delta: 5 },
        { period_start: '2026-06-15', followers: 108, delta: 4 }, { period_start: '2026-06-22', followers: 112, delta: 4 },
        { period_start: '2026-06-29', followers: 119, delta: 7 }, { period_start: p.start, followers: 128, delta: 9 }
      ],
      forecast: {
        daily_pace: 1.4,
        month_end: { date: '2026-07-31', followers: 156 },
        goal: 200,
        goal_eta: '2026-08-24',
        goal_achieved: false
      },
      audience: kind === 'daily' ? null : {
        collected_at: '2026-07-15T09:00:00Z',
        kinds: {
          demographics_age: [{ bucket: '18-24', value: 210 }, { bucket: '13-17', value: 120 }, { bucket: '25-34', value: 64 }, { bucket: '35-44', value: 18 }],
          demographics_gender: [{ bucket: 'F', value: 300 }, { bucket: 'M', value: 108 }, { bucket: 'U', value: 4 }],
          demographics_city: [{ bucket: 'Fukuoka', value: 88 }, { bucket: 'Kitakyushu', value: 41 }, { bucket: 'Kurume', value: 22 }, { bucket: 'Osaka', value: 15 }, { bucket: 'Tokyo', value: 12 }],
          online_followers: []
        }
      },
      others: [
        { handle: 'fj_broadcast', display_name: '放送部', followers: 342, delta: 4 },
        { handle: 'fj_baseball', display_name: '野球部', followers: 1280, delta: 12 },
        { handle: 'fj_soccer', display_name: 'サッカー部', followers: 954, delta: -2 },
        { handle: 'fj_brassband', display_name: '吹奏楽部', followers: 810, delta: 7 },
        { handle: 'fj_art', display_name: '美術部', followers: 233, delta: 0 },
        { handle: 'fj_dance', display_name: 'ダンス部', followers: 1522, delta: 18 },
        { handle: 'fj_kendo', display_name: '剣道部', followers: 401, delta: 1 },
        { handle: 'fj_library', display_name: '図書委員会', followers: 156, delta: -1 },
        { handle: 'fj_volleyball', display_name: 'バレーボール部', followers: 688, delta: 3 },
        { handle: 'fj_track', display_name: '陸上部', followers: 745, delta: 5 },
        { handle: 'fj_photo', display_name: '写真部', followers: 289, delta: 2 },
        { handle: 'fj_official', display_name: '学校公式', followers: 2104, delta: 9 }
      ]
    };
    var llm = noLlm ? null : {
      summary: 'この期間はフォロワーが6人増えました。特に体育祭のリール動画が平均の3.1倍のリーチとなり、フォロー増加のいちばんのきっかけになっています。全体のリーチ・反応も普段より好調でした。',
      factors: [
        '体育祭リールのリーチが平均の3.1倍と大きく伸びた',
        '18〜19時台の投稿が、見てもらいやすい時間帯と合っていた',
        '生徒総会のお知らせ投稿は保存率が高く、あとで見返される内容だった'
      ],
      actions: [
        '行事のハイライトはリール動画で週1本を目安に投稿する',
        '投稿時間は17〜19時に合わせる',
        '「お知らせまとめ」のような保存されやすい投稿を増やす'
      ],
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      generated_at: '2026-07-12T07:00:31+09:00'
    };
    return {
      kind: kind, period_start: p.start, period_end: p.end,
      account_id: 1, handle: 'example_account',
      metrics: metrics, llm: llm,
      created_at: '2026-07-12T07:00:12+09:00'
    };
  }

  loadList();
})();
`;
