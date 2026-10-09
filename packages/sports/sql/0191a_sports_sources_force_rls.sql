-- #3201 Restores FORCE ROW LEVEL SECURITY lifted by 0190a so the owner role is subject to the
-- owner-only policies again. Owner-only classification from 0190 is unchanged.
ALTER TABLE app.sports_custom_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments FORCE ROW LEVEL SECURITY;
