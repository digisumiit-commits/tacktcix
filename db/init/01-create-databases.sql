-- Init script run by PostgreSQL container on first start.
-- Creates the app database and role.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'tacktcix') THEN
        CREATE ROLE tacktcix WITH LOGIN PASSWORD 'tacktcix';
    END IF;
END
$$;

SELECT 'CREATE DATABASE tacktcix OWNER tacktcix'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tacktcix')\gexec

GRANT ALL PRIVILEGES ON DATABASE tacktcix TO tacktcix;
