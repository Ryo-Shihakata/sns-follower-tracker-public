-- v9 Phase B-2: コンテンツ分析(テーマ分類)。LLM 分類結果を保持する列。
-- nullable。分類は cron 内 classifyThemes() が theme IS NULL の投稿から埋める。
ALTER TABLE posts ADD COLUMN theme TEXT;
