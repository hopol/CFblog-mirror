-- Composite indexes matching the public listing queries (WHERE post_type/status, ORDER BY [sticky,] publish date),
-- so D1 can walk the index instead of scanning and sorting every post row.
CREATE INDEX IF NOT EXISTS idx_posts_type_status_date ON posts(post_type, status, COALESCE(published_at, created_at));
CREATE INDEX IF NOT EXISTS idx_posts_type_status_sticky_date ON posts(post_type, status, sticky, COALESCE(published_at, created_at));
