-- 投稿別分析で実際のコンテンツ(サムネイル+全文キャプション)を表示するための列。
-- thumbnail_url は失効しうる署名付き fbcdn URL。ingest ごとに最新へ更新する
-- (worker の画像プロキシ /img/:post_id が取得時にサーバー側で fetch する)。
ALTER TABLE posts ADD COLUMN thumbnail_url TEXT;
ALTER TABLE posts ADD COLUMN caption_full TEXT;
