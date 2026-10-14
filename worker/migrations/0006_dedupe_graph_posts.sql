-- Graph API 移行期の重複 posts 行を統合する。
--
-- 背景: scraping collector は external_id=shortcode、Graph API collector は
-- (修正前) external_id=数値 media id を送っていたため、同一投稿が
-- 「shortcode 行 (keep)」と「数値 media id 行 (dup)」の2行として保存された。
-- collector 側は shortcode に正規化済み (instagram_graph.py) なので、
-- ここでは既存の dup 行を keep 行へ統合する。
--
-- dup  = external_id が数字のみ (かつ url あり) の行
-- keep = 同一 account_id で external_id = dup.url から抽出した shortcode の行
-- keep が存在しない dup (Graph でしか観測していない投稿) は触らない。
-- 冪等: 統合後は dup 行が消えるため、再実行しても対応ペアが空になり何もしない。

-- 1a. dup の post_snapshots を keep 側へ複製する。
--     同一 collected_at が両方にある場合は keep 側を残す (INSERT OR IGNORE)。
WITH pairs AS (
  SELECT dup.id AS dup_id, keep.id AS keep_id
  FROM posts AS dup
  JOIN posts AS keep
    ON keep.account_id = dup.account_id
   AND keep.id <> dup.id
   AND keep.external_id = rtrim(
         replace(replace(replace(dup.url,
           'https://www.instagram.com/p/', ''),
           'https://www.instagram.com/reel/', ''),
           'https://www.instagram.com/tv/', ''),
         '/')
  WHERE dup.external_id NOT GLOB '*[^0-9]*'
    AND dup.url IS NOT NULL
)
INSERT OR IGNORE INTO post_snapshots
  (post_id, collected_at, likes, comments, views, reach, impressions, saved, source)
SELECT
  pairs.keep_id, ps.collected_at, ps.likes, ps.comments, ps.views,
  ps.reach, ps.impressions, ps.saved, ps.source
FROM post_snapshots AS ps
JOIN pairs ON ps.post_id = pairs.dup_id;

-- 1b. dup 側の post_snapshots を削除する。
WITH pairs AS (
  SELECT dup.id AS dup_id, keep.id AS keep_id
  FROM posts AS dup
  JOIN posts AS keep
    ON keep.account_id = dup.account_id
   AND keep.id <> dup.id
   AND keep.external_id = rtrim(
         replace(replace(replace(dup.url,
           'https://www.instagram.com/p/', ''),
           'https://www.instagram.com/reel/', ''),
           'https://www.instagram.com/tv/', ''),
         '/')
  WHERE dup.external_id NOT GLOB '*[^0-9]*'
    AND dup.url IS NOT NULL
)
DELETE FROM post_snapshots
WHERE post_id IN (SELECT dup_id FROM pairs);

-- 2. keep 行のメタデータを dup (Graph API 由来の方が正確) の非NULL値で更新する。
WITH pairs AS (
  SELECT dup.id AS dup_id, keep.id AS keep_id
  FROM posts AS dup
  JOIN posts AS keep
    ON keep.account_id = dup.account_id
   AND keep.id <> dup.id
   AND keep.external_id = rtrim(
         replace(replace(replace(dup.url,
           'https://www.instagram.com/p/', ''),
           'https://www.instagram.com/reel/', ''),
           'https://www.instagram.com/tv/', ''),
         '/')
  WHERE dup.external_id NOT GLOB '*[^0-9]*'
    AND dup.url IS NOT NULL
)
UPDATE posts
SET
  url           = COALESCE(d.url, posts.url),
  posted_at     = COALESCE(d.posted_at, posts.posted_at),
  media_type    = COALESCE(d.media_type, posts.media_type),
  caption_head  = COALESCE(d.caption_head, posts.caption_head),
  caption_full  = COALESCE(d.caption_full, posts.caption_full),
  thumbnail_url = COALESCE(d.thumbnail_url, posts.thumbnail_url)
FROM pairs
JOIN posts AS d ON d.id = pairs.dup_id
WHERE posts.id = pairs.keep_id;

-- 3. dup の posts 行を削除する。
WITH pairs AS (
  SELECT dup.id AS dup_id, keep.id AS keep_id
  FROM posts AS dup
  JOIN posts AS keep
    ON keep.account_id = dup.account_id
   AND keep.id <> dup.id
   AND keep.external_id = rtrim(
         replace(replace(replace(dup.url,
           'https://www.instagram.com/p/', ''),
           'https://www.instagram.com/reel/', ''),
           'https://www.instagram.com/tv/', ''),
         '/')
  WHERE dup.external_id NOT GLOB '*[^0-9]*'
    AND dup.url IS NOT NULL
)
DELETE FROM posts
WHERE id IN (SELECT dup_id FROM pairs);
