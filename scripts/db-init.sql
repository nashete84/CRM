-- Runs once when the database is first created (Docker entrypoint and CI).
-- Two roles: the owner runs migrations; the app role is what the API connects as.
-- The app role is NOT a superuser and does NOT have BYPASSRLS, so row-level
-- security added in step 2 applies to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app LOGIN PASSWORD 'crm_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE crm TO crm_app;
