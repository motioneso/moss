-- #3201 Restores FORCE ROW LEVEL SECURITY lifted by 0203a. Owner-only classification from 0159
-- is unchanged.
ALTER TABLE app.news_custom_sources FORCE ROW LEVEL SECURITY;
