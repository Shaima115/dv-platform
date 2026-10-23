-- Provisioned once by a PostgreSQL superuser (scripts/provision-db.sh).
-- psql variables: :db, :migrator_password, :core_password, :verification_password, :notification_password
-- Runtime roles are LOGIN roles with no inheritance and no special attributes. They own nothing.

SELECT format('CREATE ROLE dv_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'migrator_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dv_migrator') \gexec
SELECT format('CREATE ROLE dv_core LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'core_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dv_core') \gexec
SELECT format('CREATE ROLE dv_verification LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'verification_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dv_verification') \gexec
SELECT format('CREATE ROLE dv_notification LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'notification_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dv_notification') \gexec

-- Keep passwords in sync when re-provisioning.
SELECT format('ALTER ROLE dv_migrator PASSWORD %L', :'migrator_password') \gexec
SELECT format('ALTER ROLE dv_core PASSWORD %L', :'core_password') \gexec
SELECT format('ALTER ROLE dv_verification PASSWORD %L', :'verification_password') \gexec
SELECT format('ALTER ROLE dv_notification PASSWORD %L', :'notification_password') \gexec

SELECT format('CREATE DATABASE %I OWNER dv_migrator', :'db')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec

-- Nobody connects by default; each role is granted CONNECT explicitly.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO dv_core, dv_verification, dv_notification', :'db') \gexec
SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO dv_migrator', :'db') \gexec

\connect :db
-- The public schema is not used. Lock it down so no role can create or read objects there.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO dv_migrator;
