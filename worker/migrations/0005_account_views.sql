-- アカウント日次 views (impressions/profile_views の後継, Meta 2025-04-21 廃止による)。
-- 旧 reach 列 (0004) は継続、impressions/profile_views 列は以後 NULL のまま
-- (Instagram API with Instagram Login, graph.instagram.com/v25.0 への移行に伴う)。
ALTER TABLE snapshots ADD COLUMN views INTEGER;
