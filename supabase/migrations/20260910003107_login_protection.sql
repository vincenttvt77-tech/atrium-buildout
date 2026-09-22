-- Pre-authentication reservation only: provision the NOLOGIN/non-BYPASSRLS
-- atrium_login_executor before applying. Never grant it to HTTP login roles.
SET LOCAL ROLE atrium_admin;

CREATE TABLE atrium.login_attempt_buckets (
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('username', 'client')),
  bucket_key text NOT NULL CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  attempt_times timestamptz[] NOT NULL DEFAULT '{}'::timestamptz[],
  last_reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bucket_kind, bucket_key),
  CHECK (coalesce(array_ndims(attempt_times), 1) = 1 AND coalesce(array_lower(attempt_times, 1), 1) = 1),
  CHECK (array_position(attempt_times, NULL) IS NULL),
  CHECK (cardinality(attempt_times) <= CASE bucket_kind WHEN 'username' THEN 20 ELSE 100 END),
  CHECK ('-infinity'::timestamptz < ALL(attempt_times) AND 'infinity'::timestamptz > ALL(attempt_times)),
  CHECK (isfinite(last_reserved_at) AND last_reserved_at >= ALL(attempt_times))
);
CREATE INDEX login_attempt_buckets_expiry ON atrium.login_attempt_buckets(last_reserved_at, bucket_kind, bucket_key);
ALTER TABLE atrium.login_attempt_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE atrium.login_attempt_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON atrium.login_attempt_buckets FROM PUBLIC, atrium_app, atrium_authenticator;
CREATE POLICY maintenance ON atrium.login_attempt_buckets TO atrium_admin USING (true) WITH CHECK (true);
-- This role can touch only hashed rate buckets, exclusively through the finite command.
CREATE POLICY login_executor ON atrium.login_attempt_buckets TO atrium_login_executor USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA atrium TO atrium_login_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON atrium.login_attempt_buckets TO atrium_login_executor;

CREATE FUNCTION atrium.reserve_login_attempt(p_username_key text, p_client_key text)
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
      'atrium.channel_binding_version']) AS setting(name)
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
GRANT CREATE ON SCHEMA atrium TO atrium_login_executor;
ALTER FUNCTION atrium.reserve_login_attempt(text,text) OWNER TO atrium_login_executor;
REVOKE CREATE ON SCHEMA atrium FROM atrium_login_executor;
REVOKE ALL ON FUNCTION atrium.reserve_login_attempt(text,text) FROM PUBLIC, atrium_app;
GRANT EXECUTE ON FUNCTION atrium.reserve_login_attempt(text,text) TO atrium_authenticator;
RESET ROLE;
