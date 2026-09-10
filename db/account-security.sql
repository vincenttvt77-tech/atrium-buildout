-- Self-service credential changes only. Provision atrium_account_executor as a
-- NOLOGIN, non-BYPASSRLS role before applying; never grant it to HTTP login roles.
SET LOCAL ROLE atrium_admin;

CREATE TABLE atrium.password_change_attempts (
  id atrium.record_id PRIMARY KEY,
  user_id atrium.record_id NOT NULL REFERENCES atrium.users(id),
  credential_version atrium.positive_version NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  CHECK (consumed_at IS NULL OR consumed_at >= reserved_at)
);
CREATE INDEX password_change_attempts_user_time ON atrium.password_change_attempts(user_id, reserved_at, id);

CREATE TABLE atrium.account_security_events (
  id atrium.record_id PRIMARY KEY,
  user_id atrium.record_id NOT NULL REFERENCES atrium.users(id),
  operation text NOT NULL CHECK (operation = 'password.changed'),
  prior_credential_version atrium.positive_version NOT NULL,
  credential_version atrium.positive_version NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (credential_version = prior_credential_version + 1)
);
CREATE INDEX account_security_events_user_time ON atrium.account_security_events(user_id, created_at, id);

ALTER TABLE atrium.password_change_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE atrium.password_change_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE atrium.account_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE atrium.account_security_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON atrium.password_change_attempts, atrium.account_security_events FROM PUBLIC;
CREATE POLICY maintenance ON atrium.password_change_attempts TO atrium_admin USING (true) WITH CHECK (true);
CREATE POLICY maintenance ON atrium.account_security_events TO atrium_admin USING (true) WITH CHECK (true);

CREATE FUNCTION atrium.account_self_context() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT atrium.staff_context() AND atrium.context('login_username') IS NULL
    AND atrium.context('channel_provider') IS NULL AND atrium.context('channel_external_id') IS NULL
    AND atrium.context('channel_binding_version') IS NULL
$$;
-- The finite commands lock this self row and require the exact current credential
-- version before reading a hash or admitting any mutation. SELECT remains self-only
-- across the one-version transition performed by the existing rotation trigger.
CREATE POLICY account_self_read ON atrium.users FOR SELECT TO atrium_account_executor USING (
  atrium.account_self_context() AND id = atrium.context('actor_user_id'));
CREATE POLICY account_self_version ON atrium.users FOR UPDATE TO atrium_account_executor USING (
  atrium.account_self_context() AND id = atrium.context('actor_user_id') AND status = 'active'
  AND credential_version::text = atrium.context('credential_version')) WITH CHECK (
  atrium.account_self_context() AND id = atrium.context('actor_user_id') AND status = 'active'
  AND credential_version = atrium.context('credential_version')::bigint + 1);
CREATE POLICY account_credential_read ON atrium.user_credentials FOR SELECT TO atrium_account_executor USING (
  atrium.account_self_context() AND user_id = atrium.context('actor_user_id'));
CREATE POLICY account_credential_change ON atrium.user_credentials FOR UPDATE TO atrium_account_executor USING (
  atrium.account_self_context() AND user_id = atrium.context('actor_user_id')
  AND EXISTS (SELECT 1 FROM atrium.users u WHERE u.id = user_id AND u.status = 'active'
    AND u.credential_version::text = atrium.context('credential_version'))) WITH CHECK (
  atrium.account_self_context() AND user_id = atrium.context('actor_user_id')
  AND EXISTS (SELECT 1 FROM atrium.users u WHERE u.id = user_id AND u.status = 'active'
    -- The policy's command snapshot may still see the pre-trigger user version.
    -- The finite command checks the exact post-trigger version in its next statement.
    AND u.credential_version IN (atrium.context('credential_version')::bigint,
      atrium.context('credential_version')::bigint + 1)));
CREATE POLICY account_attempt_self ON atrium.password_change_attempts TO atrium_account_executor USING (
  atrium.account_self_context() AND user_id = atrium.context('actor_user_id')
  AND EXISTS (SELECT 1 FROM atrium.users u WHERE u.id = user_id AND u.status = 'active'
    AND u.credential_version::text = atrium.context('credential_version'))) WITH CHECK (
  atrium.account_self_context() AND user_id = atrium.context('actor_user_id')
  AND EXISTS (SELECT 1 FROM atrium.users u WHERE u.id = user_id AND u.status = 'active'
    AND u.credential_version::text = atrium.context('credential_version')));
CREATE POLICY account_event_append ON atrium.account_security_events FOR INSERT TO atrium_account_executor WITH CHECK (
  atrium.account_self_context() AND user_id = atrium.context('actor_user_id')
  AND prior_credential_version::text = atrium.context('credential_version')
  AND EXISTS (SELECT 1 FROM atrium.users u WHERE u.id = user_id AND u.status = 'active'
    AND u.credential_version = account_security_events.credential_version));

CREATE FUNCTION atrium.reserve_password_change(request_id text)
  RETURNS TABLE(outcome text, attempt_id text, user_id text, password_hash text,
    credential_version bigint, retry_after_seconds integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; current_hash text; at_time timestamptz; used integer; earliest timestamptz;
BEGIN
  IF NOT atrium.account_self_context() THEN
    RETURN QUERY SELECT 'session_changed'::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::integer; RETURN;
  END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id = atrium.context('actor_user_id') FOR UPDATE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN
    RETURN QUERY SELECT 'session_changed'::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::integer; RETURN;
  END IF;
  at_time := clock_timestamp();
  DELETE FROM atrium.password_change_attempts a WHERE a.user_id = actor.id AND a.reserved_at <= at_time - interval '15 minutes';
  SELECT count(*)::integer, min(a.reserved_at) INTO used, earliest FROM atrium.password_change_attempts a WHERE a.user_id = actor.id;
  IF used >= 10 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::text, NULL::text, NULL::text, NULL::bigint,
      greatest(1, least(900, ceil(extract(epoch FROM earliest + interval '15 minutes' - at_time))::integer)); RETURN;
  END IF;
  INSERT INTO atrium.password_change_attempts(id,user_id,credential_version,reserved_at)
    VALUES(request_id,actor.id,actor.credential_version,at_time);
  SELECT c.password_hash INTO current_hash FROM atrium.user_credentials c WHERE c.user_id = actor.id;
  RETURN QUERY SELECT 'reserved'::text, request_id, actor.id::text, current_hash, actor.credential_version::bigint, NULL::integer;
END $$;

CREATE FUNCTION atrium.commit_password_change(request_id text, verified_hash text, replacement_hash text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; attempt atrium.password_change_attempts%ROWTYPE; current_hash text; at_time timestamptz; affected integer;
BEGIN
  IF NOT atrium.account_self_context() THEN RETURN 'session_changed'; END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id = atrium.context('actor_user_id') FOR UPDATE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN 'session_changed'; END IF;
  at_time := clock_timestamp();
  SELECT a.* INTO attempt FROM atrium.password_change_attempts a WHERE a.id = request_id AND a.user_id = actor.id FOR UPDATE;
  IF NOT FOUND OR attempt.consumed_at IS NOT NULL OR attempt.credential_version <> actor.credential_version
    OR attempt.reserved_at <= at_time - interval '15 minutes' THEN RETURN 'session_changed'; END IF;
  SELECT c.password_hash INTO current_hash FROM atrium.user_credentials c WHERE c.user_id = actor.id FOR UPDATE;
  IF NOT FOUND OR current_hash IS DISTINCT FROM verified_hash THEN RETURN 'session_changed'; END IF;
  IF actor.credential_version >= 9007199254740991 OR replacement_hash IS NULL OR verified_hash = replacement_hash
    OR replacement_hash !~ '^scrypt\$65536\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'Password change cannot be completed' USING ERRCODE = '22023';
  END IF;
  UPDATE atrium.password_change_attempts SET consumed_at = at_time WHERE id = request_id AND user_id = actor.id;
  UPDATE atrium.user_credentials SET password_hash = replacement_hash WHERE user_id = actor.id AND password_hash = verified_hash;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Password change cannot be completed' USING ERRCODE = '22023'; END IF;
  -- The existing trigger is the sole owner of the one-version advancement.
  IF NOT EXISTS (SELECT 1 FROM atrium.users u WHERE u.id = actor.id AND u.credential_version = actor.credential_version + 1) THEN
    RAISE EXCEPTION 'Password change cannot be completed' USING ERRCODE = '22023';
  END IF;
  INSERT INTO atrium.account_security_events(id,user_id,operation,prior_credential_version,credential_version)
    VALUES(request_id,actor.id,'password.changed',actor.credential_version,actor.credential_version + 1);
  RETURN 'changed';
END $$;

GRANT USAGE, CREATE ON SCHEMA atrium TO atrium_account_executor;
GRANT USAGE ON TYPE atrium.record_id, atrium.positive_version TO atrium_account_executor;
GRANT EXECUTE ON FUNCTION atrium.context(text), atrium.staff_context(), atrium.account_self_context() TO atrium_account_executor;
GRANT SELECT ON atrium.users, atrium.user_credentials TO atrium_account_executor;
GRANT UPDATE(credential_version) ON atrium.users TO atrium_account_executor;
GRANT UPDATE(password_hash) ON atrium.user_credentials TO atrium_account_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON atrium.password_change_attempts TO atrium_account_executor;
GRANT INSERT ON atrium.account_security_events TO atrium_account_executor;
ALTER FUNCTION atrium.reserve_password_change(text) OWNER TO atrium_account_executor;
ALTER FUNCTION atrium.commit_password_change(text,text,text) OWNER TO atrium_account_executor;
REVOKE CREATE ON SCHEMA atrium FROM atrium_account_executor;
REVOKE ALL ON FUNCTION atrium.account_self_context(), atrium.reserve_password_change(text),
  atrium.commit_password_change(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.reserve_password_change(text), atrium.commit_password_change(text,text,text) TO atrium_authenticator;
RESET ROLE;
