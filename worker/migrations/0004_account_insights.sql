-- アカウントレベルの日次 Insights (managed アカウントの Instagram Graph API 取得時のみ)。
-- web collector 由来のスナップショットでは常に NULL のまま。
-- GAS スプレッドシート連携 (docs/gas-spreadsheet.md) のリーチ/インプレッション/
-- プロフィール閲覧数の列に対応する。
-- impressions は Graph API のバージョン/アカウントにより取得できないことがあり、その場合は NULL。
ALTER TABLE snapshots ADD COLUMN reach INTEGER;
ALTER TABLE snapshots ADD COLUMN impressions INTEGER;
ALTER TABLE snapshots ADD COLUMN profile_views INTEGER;
