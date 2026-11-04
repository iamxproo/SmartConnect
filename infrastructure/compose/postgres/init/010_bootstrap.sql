-- =============================================================================
-- SmartConnect PostgreSQL bootstrap: service schemas, roles and privileges.
--
-- * Idempotent: safe to re-run at any time. Every run also CORRECTS privilege drift.
-- * Database-name agnostic: operates on current_database().
-- * Runs automatically on a fresh data directory (docker-entrypoint-initdb.d) and is
--   applied to existing clusters by `make db-bootstrap` (infrastructure/scripts/db.mjs),
--   which also re-runs it after every `make db-migrate`.
-- * Two ways to run it, chosen by who runs it (PostgreSQL 16+):
--   - a SUPERUSER (local Docker, self-managed servers): everything below, as it always was;
--   - a MANAGED database's administrator (e.g. Render): no superuser, but CREATEROLE and the
--     ownership of this database. Same schemas, roles, grants, default privileges and RLS; the
--     differences are marked "managed" below (docs/runbooks/managed-postgres-bootstrap.md).
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
  -- Superuser: the original bootstrap. Otherwise a managed database's administrator.
  is_super CONSTANT boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
  me CONSTANT text := current_user;
  svc text;
  migrator text;
  app text;
  membership record;
  stray record;
  qualified text;
BEGIN
  -- 0. Managed: who may run it -----------------------------------------------------
  -- An administrator with CREATEROLE that owns this database: it can then create the service
  -- roles (and administer them), and harden this database and its `public` schema. Anything else
  -- stops here, before a single change.
  IF NOT is_super THEN
    IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = me) THEN
      RAISE EXCEPTION 'managed bootstrap: % needs CREATEROLE (or run it as a superuser)', me;
    END IF;
    IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = db) IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'managed bootstrap: % must own database % (it is owned by %)',
        me, db, (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = db);
    END IF;
    -- Roles created below are granted to their creator with ADMIN only (never SET or INHERIT
    -- automatically, whatever the server's default): it administers them, it does not become them.
    PERFORM set_config('createrole_self_grant', '', true);
  END IF;

  -- 1. Database-level hardening ---------------------------------------------------
  -- PostgreSQL grants CONNECT and TEMPORARY to PUBLIC on every new database.
  -- Remove both; service roles receive CONNECT explicitly below.
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db);
  -- Managed: `postgres` and `template1` belong to the provider and cannot be changed by its
  -- administrator; they hold no SmartConnect data (the provider's own access rules apply there).
  IF is_super THEN
    IF db <> 'postgres' AND EXISTS (SELECT FROM pg_database WHERE datname = 'postgres') THEN
      REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
    END IF;
    REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;   -- superusers (createdb) are unaffected
  END IF;

  -- 2. `public` schema hardening ----------------------------------------------------
  -- No application object lives in `public`. PG15+ already removed CREATE from PUBLIC;
  -- also remove USAGE so no role can resolve, or be tricked into resolving, objects there.
  -- (Owned by pg_database_owner: the managed administrator, owning the database, may do this.)
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
    IF is_super THEN
      EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                     'NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5', migrator);
      EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                     'NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 25', app);
    ELSE
      -- Managed: SUPERUSER, REPLICATION and BYPASSRLS may only be changed by a role holding them
      -- (PostgreSQL 16+), even to "off", so they are not named here. Roles this administrator
      -- created cannot have them; they are checked instead, and a role that has one is refused.
      EXECUTE format('ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5', migrator);
      EXECUTE format('ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 25', app);
      IF EXISTS (SELECT FROM pg_roles WHERE rolname IN (migrator, app)
                 AND (rolsuper OR rolreplication OR rolbypassrls)) THEN
        RAISE EXCEPTION 'managed bootstrap: % or % holds SUPERUSER, REPLICATION or BYPASSRLS — refusing to use it',
          migrator, app;
      END IF;
    END IF;

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

    -- Managed: the administrator may act AS the migrator (SET ROLE) to create its schema and to grant
    -- on the objects it owns, but never inherits its privileges (an inheriting member would count as
    -- every table's owner, and owners bypass row-level security). Nothing is granted on runtime roles.
    IF NOT is_super THEN
      EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', migrator, me);
      -- ...and nothing more, whoever granted it (a provider's createrole_self_grant when the roles
      -- were created, a manual grant): such a membership is refused, not silently kept.
      IF EXISTS (SELECT FROM pg_auth_members am
                 WHERE am.member = (SELECT oid FROM pg_roles WHERE rolname = me)
                   AND ((am.roleid IN (to_regrole(migrator), to_regrole(app)) AND am.inherit_option)
                        OR (am.roleid = to_regrole(app) AND am.set_option))) THEN
        RAISE EXCEPTION 'managed bootstrap: % inherits % or %, or may SET ROLE to % — revoke that membership first',
          me, migrator, app, app;
      END IF;
    END IF;

    -- 4. Schema, owned by the migrator ------------------------------------------------
    IF is_super THEN
      EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', svc, migrator);
      EXECUTE format('ALTER SCHEMA %I OWNER TO %I', svc, migrator);
    ELSIF to_regnamespace(svc) IS NULL THEN
      EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', svc, migrator);
    ELSIF (SELECT nspowner FROM pg_namespace WHERE nspname = svc) <> to_regrole(migrator) THEN
      -- Only possible while this administrator owns it; any other owner fails here, loudly.
      EXECUTE format('ALTER SCHEMA %I OWNER TO %I', svc, migrator);
    END IF;

    -- 5. Database access: CONNECT only. No CREATE (new schemas) and no TEMPORARY.
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I, %I', db, migrator, app);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I', db, migrator, app);

    -- Managed: what follows concerns the schema and the objects the migrator owns, so it runs AS the
    -- migrator, exactly as the owner would issue it (a superuser's grants are recorded the same way).
    IF NOT is_super THEN
      EXECUTE format('SET LOCAL ROLE %I', migrator);
    END IF;

    -- 4b. Schema privileges: USAGE for the runtime role only.
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', svc);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', svc, app);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', svc, app);

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

    IF NOT is_super THEN
      RESET ROLE;
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
  --    Managed: as the owning schema's migrator, like steps 4b–7.
  FOREACH qualified IN ARRAY append_only LOOP
    IF NOT is_super THEN
      EXECUTE format('SET LOCAL ROLE %I', format('sc_%s_migrator', split_part(qualified, '.', 1)));
    END IF;
    IF to_regclass(qualified) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE %s FROM %I',
                     qualified, format('sc_%s_app', split_part(qualified, '.', 1)));
    END IF;
    IF NOT is_super THEN
      RESET ROLE;
    END IF;
  END LOOP;
END
$bootstrap$;

-- Query statistics for performance work (superuser-only; lives in the locked-down `public`).
-- Managed: skipped here (it is not a security control, and installing it is the provider's call);
-- `db.mjs managed-bootstrap` tries it separately and reports the outcome.
DO $pg_stat_statements$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;
  END IF;
END
$pg_stat_statements$;

COMMIT;
