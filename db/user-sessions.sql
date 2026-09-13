-- Managed human sessions. Provision atrium_session_executor NOLOGIN/NOBYPASSRLS
-- before applying. Its finite commands do not read or modify password credentials.
SET LOCAL ROLE atrium_admin;

CREATE TABLE atrium.user_sessions (
  id uuid PRIMARY KEY CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  user_id atrium.record_id NOT NULL REFERENCES atrium.users(id),
  UNIQUE(id,user_id),
  credential_version atrium.positive_version NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100 AND octet_length(label) <= 400 AND label !~ '[[:cntrl:]]'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 1 AND 9007199225940991),
  last_seen_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  revoked_at_ms bigint,
  CHECK (expires_at_ms = created_at_ms + 28800000),
  CHECK (last_seen_at_ms >= created_at_ms AND last_seen_at_ms < expires_at_ms),
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms BETWEEN created_at_ms AND 9007199254740991)
);
CREATE INDEX user_sessions_active ON atrium.user_sessions(user_id,credential_version,expires_at_ms,created_at_ms,id) WHERE revoked_at_ms IS NULL;
CREATE TABLE atrium.user_session_events (
  session_id uuid NOT NULL REFERENCES atrium.user_sessions(id),
  user_id atrium.record_id NOT NULL REFERENCES atrium.users(id),
  operation text NOT NULL CHECK (operation IN ('created','revoked')),
  reason text NOT NULL CHECK (reason IN ('sign_in','session_limit','self_revoke','revoke_others')),
  at_ms bigint NOT NULL CHECK (at_ms BETWEEN 1 AND 9007199254740991),
  actor_session_id uuid,
  PRIMARY KEY(session_id,operation),
  FOREIGN KEY(session_id,user_id) REFERENCES atrium.user_sessions(id,user_id),
  CHECK ((operation='created' AND reason='sign_in') OR (operation='revoked' AND reason<>'sign_in'))
);
CREATE INDEX user_session_events_user_time ON atrium.user_session_events(user_id,at_ms,session_id);
ALTER TABLE atrium.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE atrium.user_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE atrium.user_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE atrium.user_session_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON atrium.user_sessions,atrium.user_session_events FROM PUBLIC,atrium_app,atrium_authenticator;
CREATE POLICY maintenance ON atrium.user_sessions TO atrium_admin USING (true) WITH CHECK (true);
CREATE POLICY maintenance ON atrium.user_session_events TO atrium_admin USING (true) WITH CHECK (true);
-- This leaf policy deliberately does not read users or call staff_context: those
-- policies depend on this session check, and password rotation advances users once.
CREATE POLICY selected_session ON atrium.user_sessions FOR SELECT TO atrium_app,atrium_authenticator,atrium_account_executor USING (
  id::text=atrium.context('session_id') AND user_id=atrium.context('actor_user_id')
  AND credential_version::text=atrium.context('credential_version'));
CREATE POLICY session_executor ON atrium.user_sessions TO atrium_session_executor USING (
  user_id=atrium.context('actor_user_id')) WITH CHECK (user_id=atrium.context('actor_user_id'));
CREATE POLICY session_event_append ON atrium.user_session_events FOR INSERT TO atrium_session_executor WITH CHECK (
  user_id=atrium.context('actor_user_id') AND EXISTS (SELECT 1 FROM atrium.user_sessions s
    WHERE s.id=session_id AND s.user_id=user_session_events.user_id));
CREATE POLICY session_identity ON atrium.users FOR SELECT TO atrium_session_executor USING (id=atrium.context('actor_user_id'));
-- UPDATE privilege is needed by SELECT FOR UPDATE; the executor has no command
-- that changes users, and WITH CHECK false prohibits any actual user-row write.
CREATE POLICY session_identity_lock ON atrium.users FOR UPDATE TO atrium_session_executor USING (
  id=atrium.context('actor_user_id')) WITH CHECK (false);

CREATE FUNCTION atrium.session_context_valid() RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT atrium.context('session_id') IS NULL OR EXISTS (
    SELECT 1 FROM atrium.user_sessions s WHERE s.id=CASE WHEN atrium.context('session_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN atrium.context('session_id')::uuid END
      AND s.user_id=atrium.context('actor_user_id')
      AND s.credential_version::text=atrium.context('credential_version')
      AND s.revoked_at_ms IS NULL AND s.expires_at_ms > floor(extract(epoch FROM clock_timestamp())*1000))
$$;
CREATE OR REPLACE FUNCTION atrium.staff_context() RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT atrium.context('actor_user_id') IS NOT NULL AND atrium.context('credential_version') IS NOT NULL
    AND atrium.context('channel_binding_id') IS NULL AND atrium.session_context_valid()
$$;
CREATE OR REPLACE FUNCTION atrium.channel_context() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT atrium.context('channel_binding_id') IS NOT NULL AND atrium.context('channel_binding_version') IS NOT NULL
    AND atrium.context('actor_user_id') IS NULL AND atrium.context('credential_version') IS NULL
    AND atrium.context('session_id') IS NULL
$$;
ALTER POLICY auth_binding ON atrium.channel_bindings USING (
  atrium.context('session_id') IS NULL AND atrium.context('actor_user_id') IS NULL
  AND atrium.context('credential_version') IS NULL
  AND provider=atrium.context('channel_provider') AND external_id=atrium.context('channel_external_id'));
-- Password lookup remains explicitly pre-login. Authenticated catalogue/identity
-- reads with a provided session must also recheck its current state.
ALTER POLICY auth_identity ON atrium.users USING (
  (id=atrium.context('actor_user_id') AND atrium.session_context_valid()
    AND (atrium.context('session_id') IS NULL OR (status='active' AND credential_version::text=atrium.context('credential_version'))))
  OR (username=atrium.context('login_username') AND atrium.context('session_id') IS NULL
    AND atrium.context('actor_user_id') IS NULL AND atrium.context('credential_version') IS NULL));
ALTER POLICY auth_membership ON atrium.memberships USING (
  atrium.session_context_valid() AND user_id=atrium.context('actor_user_id') AND EXISTS (
    SELECT 1 FROM atrium.users u WHERE u.id=memberships.user_id AND u.status='active'
      AND u.credential_version::text=atrium.context('credential_version')));

CREATE FUNCTION atrium.session_command_context() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT session_user='atrium_authenticator' AND atrium.context('actor_user_id') IS NOT NULL
    AND atrium.context('credential_version') IS NOT NULL AND atrium.context('login_username') IS NULL
    AND atrium.context('organization_id') IS NULL AND atrium.context('property_id') IS NULL
    AND atrium.context('channel_provider') IS NULL AND atrium.context('channel_external_id') IS NULL
    AND atrium.context('channel_binding_id') IS NULL AND atrium.context('channel_binding_version') IS NULL
$$;
CREATE FUNCTION atrium.preserve_user_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Session history is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.credential_version IS DISTINCT FROM OLD.credential_version OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms OR NEW.expires_at_ms IS DISTINCT FROM OLD.expires_at_ms
    OR NEW.last_seen_at_ms < OLD.last_seen_at_ms
    OR (OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms IS DISTINCT FROM OLD.revoked_at_ms) THEN
    RAISE EXCEPTION 'Session identity and lifetime are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_user_session BEFORE UPDATE OR DELETE ON atrium.user_sessions
  FOR EACH ROW EXECUTE FUNCTION atrium.preserve_user_session();
CREATE FUNCTION atrium.preserve_user_session_event() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Session audit is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER preserve_user_session_event BEFORE UPDATE OR DELETE ON atrium.user_session_events
  FOR EACH ROW EXECUTE FUNCTION atrium.preserve_user_session_event();

CREATE FUNCTION atrium.start_user_session(p_id uuid,p_label text) RETURNS SETOF atrium.user_sessions
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; stamp bigint; victim uuid; active_count integer;
BEGIN
  IF NOT atrium.session_command_context() OR atrium.context('session_id') IS NOT NULL THEN
    RAISE EXCEPTION 'Current sign-in is required' USING ERRCODE='28000';
  END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id=atrium.context('actor_user_id') FOR UPDATE;
  IF NOT FOUND OR actor.status<>'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN
    RAISE EXCEPTION 'Current sign-in is required' USING ERRCODE='28000';
  END IF;
  stamp := floor(extract(epoch FROM clock_timestamp())*1000);
  -- User-first lock order also serializes password rotation, creation and revocation.
  SELECT count(*) INTO active_count FROM atrium.user_sessions s WHERE s.user_id=actor.id
    AND s.credential_version=actor.credential_version AND s.revoked_at_ms IS NULL AND s.expires_at_ms>stamp;
  IF active_count>=20 THEN
    FOR victim IN SELECT s.id FROM atrium.user_sessions s WHERE s.user_id=actor.id
      AND s.credential_version=actor.credential_version AND s.revoked_at_ms IS NULL AND s.expires_at_ms>stamp
      ORDER BY s.created_at_ms,s.id LIMIT active_count-19 FOR UPDATE LOOP
      UPDATE atrium.user_sessions SET revoked_at_ms=greatest(stamp,created_at_ms) WHERE id=victim;
      INSERT INTO atrium.user_session_events(session_id,user_id,operation,reason,at_ms,actor_session_id)
        SELECT id,user_id,'revoked','session_limit',revoked_at_ms,p_id FROM atrium.user_sessions WHERE id=victim;
    END LOOP;
  END IF;
  INSERT INTO atrium.user_sessions(id,user_id,credential_version,label,created_at_ms,last_seen_at_ms,expires_at_ms)
    VALUES(p_id,actor.id,actor.credential_version,p_label,stamp,stamp,stamp+28800000);
  INSERT INTO atrium.user_session_events(session_id,user_id,operation,reason,at_ms)
    VALUES(p_id,actor.id,'created','sign_in',stamp);
  RETURN QUERY SELECT s.* FROM atrium.user_sessions s WHERE s.id=p_id;
END $$;

CREATE FUNCTION atrium.resolve_user_session(p_expires_at_ms bigint) RETURNS SETOF atrium.user_sessions
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; stamp bigint; selected atrium.user_sessions%ROWTYPE;
BEGIN
  IF NOT atrium.session_command_context() OR atrium.context('session_id') IS NULL THEN RETURN; END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id=atrium.context('actor_user_id') FOR SHARE;
  IF NOT FOUND OR actor.status<>'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  SELECT s.* INTO selected FROM atrium.user_sessions s WHERE s.id::text=atrium.context('session_id') AND s.user_id=actor.id
    AND s.credential_version=actor.credential_version AND s.expires_at_ms=p_expires_at_ms AND s.expires_at_ms>stamp AND s.revoked_at_ms IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  IF selected.expires_at_ms<=stamp THEN RETURN; END IF;
  IF stamp-selected.last_seen_at_ms>=60000 THEN
    UPDATE atrium.user_sessions SET last_seen_at_ms=stamp WHERE id=selected.id RETURNING * INTO selected;
  END IF;
  RETURN NEXT selected;
END $$;

CREATE FUNCTION atrium.list_user_sessions() RETURNS SETOF atrium.user_sessions
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; stamp bigint;
BEGIN
  IF NOT atrium.session_command_context() OR atrium.context('session_id') IS NULL THEN
    RAISE EXCEPTION 'Current session is required' USING ERRCODE='28000'; END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id=atrium.context('actor_user_id') FOR SHARE;
  IF NOT FOUND OR actor.status<>'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version')
    OR NOT atrium.session_context_valid() THEN RAISE EXCEPTION 'Current session is required' USING ERRCODE='28000'; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  RETURN QUERY SELECT s.* FROM atrium.user_sessions s WHERE s.user_id=actor.id AND s.credential_version=actor.credential_version
    AND s.expires_at_ms>stamp AND s.revoked_at_ms IS NULL ORDER BY s.created_at_ms DESC,s.id;
END $$;

CREATE FUNCTION atrium.revoke_user_sessions(p_target text) RETURNS TABLE(revoked_ids uuid[],current_revoked boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; stamp bigint; selected atrium.user_sessions%ROWTYPE; ids uuid[]:='{}';
BEGIN
  IF NOT atrium.session_command_context() OR atrium.context('session_id') IS NULL THEN
    RAISE EXCEPTION 'Current session is required' USING ERRCODE='28000'; END IF;
  IF p_target IS NULL OR (p_target<>'others' AND p_target!~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Invalid session selection' USING ERRCODE='22023'; END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id=atrium.context('actor_user_id') FOR UPDATE;
  IF NOT FOUND OR actor.status<>'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version')
    OR NOT atrium.session_context_valid() THEN RAISE EXCEPTION 'Current session is required' USING ERRCODE='28000'; END IF;
  IF p_target<>'others' AND NOT EXISTS (SELECT 1 FROM atrium.user_sessions s WHERE s.id=p_target::uuid AND s.user_id=actor.id) THEN
    RAISE EXCEPTION 'Invalid session selection' USING ERRCODE='22023'; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  FOR selected IN SELECT s.* FROM atrium.user_sessions s WHERE s.user_id=actor.id AND s.credential_version=actor.credential_version
    AND s.revoked_at_ms IS NULL AND s.expires_at_ms>stamp
    AND CASE WHEN p_target='others' THEN s.id::text<>atrium.context('session_id') ELSE s.id::text=p_target END
    ORDER BY s.id FOR UPDATE LOOP
    UPDATE atrium.user_sessions SET revoked_at_ms=greatest(stamp,created_at_ms) WHERE id=selected.id;
    INSERT INTO atrium.user_session_events(session_id,user_id,operation,reason,at_ms,actor_session_id)
      VALUES(selected.id,actor.id,'revoked',CASE WHEN p_target='others' THEN 'revoke_others' ELSE 'self_revoke' END,
        greatest(stamp,selected.created_at_ms),atrium.context('session_id')::uuid);
    ids:=array_append(ids,selected.id);
  END LOOP;
  RETURN QUERY SELECT ids,atrium.context('session_id')::uuid=ANY(ids);
END $$;

-- Property transactions take this fence before touching property rows. Revocation
-- and password rotation take user FOR UPDATE first, so they cannot commit ahead
-- of an already admitted property transaction. No network IO belongs under it.
CREATE FUNCTION atrium.hold_current_session() RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; selected atrium.user_sessions%ROWTYPE; stamp bigint;
BEGIN
  IF session_user<>'atrium_app' OR atrium.context('actor_user_id') IS NULL
    OR atrium.context('credential_version') IS NULL OR atrium.context('session_id') IS NULL
    OR atrium.context('login_username') IS NOT NULL OR atrium.context('channel_provider') IS NOT NULL
    OR atrium.context('channel_external_id') IS NOT NULL OR atrium.context('channel_binding_id') IS NOT NULL
    OR atrium.context('channel_binding_version') IS NOT NULL THEN RETURN false; END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id=atrium.context('actor_user_id') FOR SHARE;
  IF NOT FOUND OR actor.status<>'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN false; END IF;
  SELECT s.* INTO selected FROM atrium.user_sessions s WHERE s.id=CASE
      WHEN atrium.context('session_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN atrium.context('session_id')::uuid END
    AND s.user_id=actor.id AND s.credential_version=actor.credential_version FOR SHARE;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  RETURN FOUND AND selected.revoked_at_ms IS NULL AND selected.expires_at_ms>stamp;
END $$;

GRANT USAGE,CREATE ON SCHEMA atrium TO atrium_session_executor;
GRANT USAGE ON TYPE atrium.record_id,atrium.positive_version TO atrium_session_executor;
GRANT EXECUTE ON FUNCTION atrium.context(text),atrium.session_command_context(),atrium.session_context_valid() TO atrium_session_executor;
GRANT SELECT ON atrium.users TO atrium_session_executor;
GRANT UPDATE(id) ON atrium.users TO atrium_session_executor;
GRANT SELECT,INSERT,UPDATE ON atrium.user_sessions TO atrium_session_executor;
GRANT INSERT ON atrium.user_session_events TO atrium_session_executor;
GRANT SELECT ON atrium.user_sessions TO atrium_app,atrium_authenticator,atrium_account_executor;
GRANT EXECUTE ON FUNCTION atrium.session_context_valid() TO atrium_app,atrium_authenticator,atrium_account_executor;
ALTER FUNCTION atrium.hold_current_session() OWNER TO atrium_session_executor;
ALTER FUNCTION atrium.start_user_session(uuid,text) OWNER TO atrium_session_executor;
ALTER FUNCTION atrium.resolve_user_session(bigint) OWNER TO atrium_session_executor;
ALTER FUNCTION atrium.list_user_sessions() OWNER TO atrium_session_executor;
ALTER FUNCTION atrium.revoke_user_sessions(text) OWNER TO atrium_session_executor;
REVOKE CREATE ON SCHEMA atrium FROM atrium_session_executor;
REVOKE ALL ON FUNCTION atrium.session_context_valid(),atrium.session_command_context(),atrium.preserve_user_session(),atrium.preserve_user_session_event(),
  atrium.start_user_session(uuid,text),atrium.resolve_user_session(bigint),atrium.list_user_sessions(),atrium.revoke_user_sessions(text),atrium.hold_current_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.hold_current_session() TO atrium_app;
GRANT EXECUTE ON FUNCTION atrium.start_user_session(uuid,text),atrium.resolve_user_session(bigint),atrium.list_user_sessions(),atrium.revoke_user_sessions(text) TO atrium_authenticator;
RESET ROLE;

-- An inherited managed-session context is never pre-authentication.
SET LOCAL ROLE atrium_admin;
CREATE OR REPLACE FUNCTION atrium.reserve_login_attempt(p_username_key text, p_client_key text)
RETURNS TABLE(allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now timestamptz;
  v_client_times timestamptz[];
  v_username_times timestamptz[];
  v_last timestamptz;
  v_allowed boolean := false;
  v_locked boolean;
  v_lock_attempt integer;
  v_retry numeric := 0;
BEGIN
  IF session_user <> 'atrium_authenticator' OR EXISTS (
    SELECT 1 FROM unnest(ARRAY['atrium.actor_user_id', 'atrium.credential_version',
      'atrium.organization_id', 'atrium.property_id', 'atrium.login_username',
      'atrium.channel_provider', 'atrium.channel_external_id', 'atrium.channel_binding_id',
      'atrium.channel_binding_version', 'atrium.session_id']) AS setting(name)
    WHERE nullif(current_setting(setting.name, true), '') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Login reservation requires an unauthenticated context.' USING ERRCODE = '42501';
  END IF;
  IF p_username_key IS NULL OR p_client_key IS NULL
    OR p_username_key !~ '^[0-9a-f]{64}$' OR p_client_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid login reservation keys.' USING ERRCODE = '22023';
  END IF;

  -- Every request takes client then username locks; denied clients never allocate username rows.
  -- Bounded reacquisition handles cleanup deleting an expired row between a conflicting
  -- insert and SELECT FOR UPDATE, without issuing no-op writes on every denial.
  v_now := clock_timestamp();
  v_locked := false;
  FOR v_lock_attempt IN 1..3 LOOP
    INSERT INTO atrium.login_attempt_buckets(bucket_kind, bucket_key, last_reserved_at)
      VALUES ('client', p_client_key, v_now) ON CONFLICT DO NOTHING;
    SELECT attempt_times, last_reserved_at INTO v_client_times, v_last
      FROM atrium.login_attempt_buckets WHERE bucket_kind = 'client' AND bucket_key = p_client_key FOR UPDATE;
    v_locked := FOUND;
    EXIT WHEN v_locked;
  END LOOP;
  IF NOT v_locked THEN
    RAISE EXCEPTION 'Login reservation lock is unavailable.' USING ERRCODE = '40001';
  END IF;
  v_now := clock_timestamp();
  SELECT coalesce(array_agg(t ORDER BY t), '{}'::timestamptz[]) INTO v_client_times
    FROM unnest(v_client_times) AS stamp(t) WHERE t > v_now - interval '15 minutes';
  IF cardinality(v_client_times) >= 100 THEN
    v_retry := greatest(1, ceil(extract(epoch FROM (v_client_times[1] + interval '15 minutes' - v_now))));
  ELSE
    -- A backwards wall clock must not erase future reservations or reorder the queue.
    v_client_times := array_append(v_client_times, greatest(v_now, v_last));
    UPDATE atrium.login_attempt_buckets SET attempt_times = v_client_times, last_reserved_at = greatest(v_now, v_last)
      WHERE bucket_kind = 'client' AND bucket_key = p_client_key;

    v_locked := false;
    FOR v_lock_attempt IN 1..3 LOOP
      INSERT INTO atrium.login_attempt_buckets(bucket_kind, bucket_key, last_reserved_at)
        VALUES ('username', p_username_key, v_now) ON CONFLICT DO NOTHING;
      SELECT attempt_times, last_reserved_at INTO v_username_times, v_last
        FROM atrium.login_attempt_buckets WHERE bucket_kind = 'username' AND bucket_key = p_username_key FOR UPDATE;
      v_locked := FOUND;
      EXIT WHEN v_locked;
    END LOOP;
    IF NOT v_locked THEN
      RAISE EXCEPTION 'Login reservation lock is unavailable.' USING ERRCODE = '40001';
    END IF;
    v_now := clock_timestamp();
    SELECT coalesce(array_agg(t ORDER BY t), '{}'::timestamptz[]) INTO v_username_times
      FROM unnest(v_username_times) AS stamp(t) WHERE t > v_now - interval '15 minutes';
    IF cardinality(v_username_times) >= 20 THEN
      -- Client budget is charged even when username budget refuses password work.
      -- Do not append/update the denied username: denial cannot extend its window.
      v_retry := greatest(1, ceil(extract(epoch FROM (v_username_times[1] + interval '15 minutes' - v_now))));
      IF cardinality(v_client_times) >= 100 THEN
        v_retry := greatest(v_retry, ceil(extract(epoch FROM (v_client_times[1] + interval '15 minutes' - v_now))));
      END IF;
    ELSE
      v_username_times := array_append(v_username_times, greatest(v_now, v_last));
      UPDATE atrium.login_attempt_buckets SET attempt_times = v_username_times, last_reserved_at = greatest(v_now, v_last)
        WHERE bucket_kind = 'username' AND bucket_key = p_username_key;
      v_allowed := true;
    END IF;
  END IF;
  IF v_retry > 2147483647 THEN
    RAISE EXCEPTION 'Login reservation clock horizon is unavailable.' USING ERRCODE = '22003';
  END IF;

  -- Bounded cleanup also runs after either denial. SKIP LOCKED never waits on
  -- another reservation, and current keys are retained through this transaction.
  WITH expired AS (
    SELECT bucket_kind, bucket_key FROM atrium.login_attempt_buckets
      WHERE last_reserved_at <= v_now - interval '15 minutes'
        AND NOT (bucket_kind = 'client' AND bucket_key = p_client_key)
        AND NOT (bucket_kind = 'username' AND bucket_key = p_username_key)
      ORDER BY last_reserved_at, bucket_kind, bucket_key LIMIT 50 FOR UPDATE SKIP LOCKED
  ) DELETE FROM atrium.login_attempt_buckets b USING expired e
    WHERE b.bucket_kind = e.bucket_kind AND b.bucket_key = e.bucket_key;
  RETURN QUERY SELECT v_allowed, v_retry::integer;
END;
$$;
RESET ROLE;
