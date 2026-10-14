# GAS × スプレッドシート連携（日次エクスポート）

SCTracker の worker が持つ日次データを、Google Apps Script（GAS）で
スプレッドシートに定期出力する手順。時系列で
「日付 / フォロー数 / フォロワー数 / 増減 / 投稿数 / 増減 /
リーチ数 / 増減 / 前日比 / ビュー数 / 増減 / 前日比」の12列を出力する。

> 旧インプレッション数/プロフィール閲覧数の列は、Meta が2025-04-21にこれらの
> Instagram Insightsメトリクスを完全廃止したため削除した。後継の `views` に統合されている。

## データの出どころと前提

- worker の読取 API `GET /api/export/daily?account_id=<id>`（Bearer `READ_API_TOKEN`）が
  12列の表（`{columns, rows}` JSON、`&format=csv` で CSV）を返す。
- **フォロワー数・フォロー数・投稿数**は全アカウントで即出力できる。
- **リーチ / ビュー数**は Instagram Graph API の
  *アカウントレベル日次 Insights* で、次の両方が揃ったアカウントだけ値が入る（他は空欄）:
  1. そのアカウントが `managed=1`（ダッシュボードの設定で切替）
  2. サーバ `.env` に Graph API トークンが設定済み（[graph-api-setup.md](../collector/docs/graph-api-setup.md)）
     - `views` は Graph API のバージョン/アカウントによっては取得できず、その場合は空欄のまま。
- 「日付」は UTC 基準の暦日（各日の最終スナップショットを採用）。
- account_id はダッシュボードの「設定 → アカウント管理」の ID 列で確認できる。

## セットアップ手順

1. 出力先の Google スプレッドシートを開く → **拡張機能 → Apps Script**。
2. 下の `コード.gs` を貼り付ける。
3. **プロジェクトの設定 → スクリプト プロパティ** に次を追加:
   - `WORKER_BASE` = `https://sns-follower-tracker.<your-subdomain>.workers.dev`
   - `READ_API_TOKEN` = worker の READ_API_TOKEN（`npx wrangler secret list` で存在確認。値は発行時のもの）
4. スクリプト内 `ACCOUNTS` を出力したいアカウントに合わせて編集（`id` とタブ名 `sheet`）。
5. 関数 `syncSC` を一度手動実行し、初回だけ承認（外部URL fetch の許可）を通す。
6. 関数 `installDailyTrigger` を一度実行すると、毎日自動更新のトリガーが入る。

> セキュリティ: `READ_API_TOKEN` はスクリプト プロパティに置き、コードに直書きしない。
> 読取専用トークンなので書込（/ingest）はできない。権限設計は [../docs/](./) 参照。

## コード.gs

```javascript
// ==== 設定 ====
// 出力したいアカウント。id はダッシュボードの「設定」の ID 列、sheet はタブ名。
var ACCOUNTS = [
  { id: 1, sheet: 'example_account' },
  // { id: 2, sheet: 'fukuoka_jyoto' },
];
// 取得期間（日数）。0 または未指定なら全期間。
var DAYS = 400;

function _props() {
  var p = PropertiesService.getScriptProperties();
  var base = p.getProperty('WORKER_BASE');
  var token = p.getProperty('READ_API_TOKEN');
  if (!base || !token) throw new Error('スクリプト プロパティ WORKER_BASE / READ_API_TOKEN を設定してください');
  return { base: base.replace(/\/+$/, ''), token: token };
}

function _fetchDaily(accountId) {
  var cfg = _props();
  var url = cfg.base + '/api/export/daily?account_id=' + encodeURIComponent(accountId);
  if (DAYS && DAYS > 0) {
    var from = new Date(Date.now() - DAYS * 86400000).toISOString();
    url += '&from=' + encodeURIComponent(from);
  }
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + cfg.token },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('API ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText()); // { columns, rows }
}

function _writeSheet(sheetName, data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  sheet.clearContents();
  var cols = data.columns;
  sheet.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  if (data.rows.length > 0) {
    sheet.getRange(2, 1, data.rows.length, cols.length).setValues(data.rows);
    // 前日比の2列（リーチ前日比=9列目, ビュー前日比=12列目）をパーセント表示にする。
    [9, 12].forEach(function (c) {
      sheet.getRange(2, c, data.rows.length, 1).setNumberFormat('0.00%');
    });
  }
  sheet.setFrozenRows(1);
}

// 全アカウントを更新（トリガーからも手動でもこれを呼ぶ）。
function syncSC() {
  ACCOUNTS.forEach(function (a) {
    var data = _fetchDaily(a.id);
    _writeSheet(a.sheet, data);
  });
}

// 毎日自動更新のトリガーを1本だけ設定する（重複作成を防ぐ）。
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncSC') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncSC').timeBased().everyDays(1).atHour(9).create();
}
```

## 動作確認

- `syncSC` 実行後、各タブに12列＋日次行が入る。
- リーチ以降が空欄なら、そのアカウントは Graph API 未連携（web 取得のみ）。想定どおり。
- 増減・前日比は前日データが2日以上たまってから埋まる（初日は空欄）。

## 関連

- 読取 API 実装: `worker/src/routes/insights.ts`（`/api/export/daily`）、集計 `worker/src/lib/analytics.ts`（`getDailyExport`）。
- Graph API 有効化: [../collector/docs/graph-api-setup.md](../collector/docs/graph-api-setup.md)。
