-- =============================================================================
-- SmartConnect PostgreSQL bootstrap: service schemas, roles and privileges.
--
-- * Idempotent: safe to re-run at any time. Every run also CORRECTS privilege drift.
-- * Database-name agnostic: operates on current_database().
-- * Runs automatically on a fresh data directory (docker-entrypoint-initdb.d) and is
--   applied to existing clusters by `make db-bootstrap` (infrastructure/scripts/db.mjs),
--   which also re-runs it after every `make db-migrate`.
-- * Must be executed by a superuser (production: the platform admin role).
-- * Sets NO passwords. LOGIN roles without a password cannot authenticate, so a freshly
--   bootstrapped cluster stays closed until credentials are provisioned.
--
-- Model (per service <svc>):
--   schema  <svc>               owned by sc_<svc>_migrator
--   role    sc_<svc>_migrator   LOGIN, owns the schema + every object in it, runs migrations
--   role    sc_<svc>_app        LOGIN, runtime: USAGE + DML only, never owns or creates objects
-- See docs/database/security.md.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = error;   -- REVOKE of a never-granted privilege only warns

DO $bootstrap$
DECLARE
  -- The authoritative list of service-owned schemas. Adding a service = adding it here.
  services CONSTANT text[] := ARRAY[
    'identity', 'organization', 'workspace', 'messaging', 'presence', 'meetings', 'files',
    'notifications', 'search', 'documents', 'tasks', 'workflows', 'integrations', 'administration'
  ];
  -- Append-only tables (schema.table): the runtime role may INSERT/SELECT but never UPDATE/DELETE.
  append_only CONSTANT text[] := ARRAY['administration.audit_logs'];
  db CONSTANT text := current_database();
  svc text;
  migrator text;
  app text;
  membership record;
  stray record;
  qualified text;
BEGIN
  -- 1. Database-level hardening ---------------------------------------------------
  -- PostgreSQL grants CONNECT and TEMPORARY to PUBLIC on every new database.
  -- Remove both; service roles receive CONNECT explicitly below.
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db);
  IF db <> 'postgres' AND EXISTS (SELECT FROM pg_database WHERE datname = 'postgres') THEN
    REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
  END IF;
  REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;   -- superusers (createdb) are unaffected

  -- 2. `public` schema hardening ----------------------------------------------------
  -- No application object lives in `public`. PG15+ already removed CREATE from PUBLIC;
  -- also remove USAGE so no role can resolve, or be tricked into resolving, objects there.
  REVOKE ALL ON SCHEMA public FROM PUBLIC;

  FOREACH svc IN ARRAY services LOOP
    migrator := format('sc_%s_migrator', svc);
    app      := format('sc_%s_app', svc);

    -- 3. Roles -------------------------------------------------------------------
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = migrator) THEN
      EXECUTE format('CREATE ROLE %I', migrator);
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = app) THEN
      EXECUTE format('CREATE ROLE %I', app);
    END IF;
    -- Re-asserted on every run so manual changes are reverted.
    EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                   'NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5', migrator);
    EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                   'NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 25', app);

    -- Service roles must not inherit privileges from any other role.
    FOR membership IN
      SELECT r.rolname AS granted_role, m.rolname AS member
      FROM pg_auth_members am
      JOIN pg_roles r ON r.oid = am.roleid
      JOIN pg_roles m ON m.oid = am.member
      WHERE m.rolname IN (migrator, app)
    LOOP
      EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member);
    END LOOP;

    -- 4. Schema, owned by the migrator ------------------------------------------------
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', svc, migrator);
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', svc, migrator);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', svc);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', svc, app);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', svc, app);

    -- 5. Database access: CONNECT only. No CREATE (new schemas) and no TEMPORARY.
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I, %I', db, migrator, app);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I', db, migrator, app);

    -- 6. Default privileges: applied to every object the migrator creates in its schema.
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
                   'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', migrator, svc, app);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
                   'GRANT USAGE, SELECT ON SEQUENCES TO %I', migrator, svc, app);
    -- Functions are executable by PUBLIC by default: restrict them to the runtime role.
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', migrator);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
                   'GRANT EXECUTE ON FUNCTIONS TO %I', migrator, svc, app);

    -- 6b. Drift correction for objects that ALREADY exist (default privileges only cover future
    --     ones): strip every grantee other than owner and runtime role, then re-grant exactly the
    --     intended set. Steps 7 and 9 re-apply the deliberate exceptions afterwards.
    FOR stray IN
      SELECT DISTINCT a.grantee::regrole::text AS grantee
      FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE n.nspname = svc AND a.grantee NOT IN (0, n.nspowner, to_regrole(app))
      UNION
      SELECT DISTINCT a.grantee::regrole::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
      WHERE n.nspname = svc AND a.grantee NOT IN (0, c.relowner, to_regrole(app))
      UNION
      SELECT DISTINCT a.grantee::regrole::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
      WHERE n.nspname = svc AND a.grantee NOT IN (0, p.proowner, to_regrole(app))
    LOOP
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %s', svc, stray.grantee);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %s', svc, stray.grantee);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %s', svc, stray.grantee);
      EXECUTE format('REVOKE ALL ON ALL ROUTINES IN SCHEMA %I FROM %s', svc, stray.grantee);
    END LOOP;
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC, %I', svc, app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', svc, app);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC, %I', svc, app);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', svc, app);
    EXECUTE format('REVOKE ALL ON ALL ROUTINES IN SCHEMA %I FROM PUBLIC, %I', svc, app);
    EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA %I TO %I', svc, app);

    -- 7. Migration history belongs to the migrator. The runtime role must not read or
    --    tamper with it (default privileges above would otherwise grant DML on it).
    IF to_regclass(format('%I._prisma_migrations', svc)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE %I._prisma_migrations FROM %I', svc, app);
    END IF;

    -- 8. Session defaults (role + database scoped).
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path = %I', migrator, db, svc);
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path = %I', app, db, svc);
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L', app, db, '15s');
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET lock_timeout = %L', app, db, '5s');
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L', app, db, '30s');
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET lock_timeout = %L', migrator, db, '10s');
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L', migrator, db, '5min');
  END LOOP;

  -- 9. Append-only tables. Applied once the owning migration has created them (bootstrap re-runs
  --    after every `make db-migrate`); a trigger in the migration also blocks mutation meanwhile.
  FOREACH qualified IN ARRAY append_only LOOP
    IF to_regclass(qualified) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE %s FROM %I',
                     qualified, format('sc_%s_app', split_part(qualified, '.', 1)));
    END IF;
  END LOOP;
END
$bootstrap$;

-- Query statistics for performance work (superuser-only; lives in the locked-down `public`).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;

COMMIT;
