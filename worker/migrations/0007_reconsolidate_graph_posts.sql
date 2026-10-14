-- 0006 の再適用 + 数値 external_id 行の shortcode リネーム。
--
-- 背景: 0006 適用(2026-07-11 ~10:00 UTC)の後、collector イメージ再ビルド
-- (17:14 UTC)前の 10:34 UTC に旧 collector が1回実行され、数値 media id の
-- 重複行が再作成された。また 0006 は「shortcode 側の keep 行が存在しない
-- 数値行」を触らずに残したため、修正済み collector が同じ投稿を shortcode で
-- 再観測した際に逆向きの重複(数値=旧 / shortcode=新)も発生した。
--
-- 対策:
--   手順1〜3: 0006 と同一の統合ロジック(dup=数値行 → keep=shortcode 行)。
--   手順4:    統合後も残る数値行(keep が存在しない)を、url から抽出した
--             shortcode へリネームする。以後 collector は常に shortcode を
--             送るため、この形の重複は構造的に発生しなくなる。
-- 冪等: 統合は dup 行の削除で、リネームは数値 GLOB 不一致で、再実行しても無害。

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

-- 2. keep 行のメタデータを dup の非NULL値で補完する。
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

-- 4. 統合後も残った数値 external_id 行を shortcode へリネームする。
--    url が既知の3形式のときだけ抽出し、同一アカウント内で衝突しないことを
--    NOT EXISTS で二重に保証する(UNIQUE 制約違反による migration 失敗防止)。
UPDATE posts
SET external_id = rtrim(
      replace(replace(replace(url,
        'https://www.instagram.com/p/', ''),
        'https://www.instagram.com/reel/', ''),
        'https://www.instagram.com/tv/', ''),
      '/')
WHERE external_id NOT GLOB '*[^0-9]*'
  AND url IS NOT NULL
  AND (url GLOB 'https://www.instagram.com/p/*'
    OR url GLOB 'https://www.instagram.com/reel/*'
    OR url GLOB 'https://www.instagram.com/tv/*')
  AND NOT EXISTS (
    SELECT 1 FROM posts AS k
    WHERE k.account_id = posts.account_id
      AND k.id <> posts.id
      AND k.external_id = rtrim(
            replace(replace(replace(posts.url,
              'https://www.instagram.com/p/', ''),
              'https://www.instagram.com/reel/', ''),
              'https://www.instagram.com/tv/', ''),
            '/')
  );
