-- Persisted authentication audience. Existing sessions remain staff sessions.
-- Audience is independent of membership: a resident session never acquires staff
-- authority, even when its underlying account has an active owner membership.
SET LOCAL ROLE atrium_admin;
ALTER TABLE atrium.user_sessions ADD COLUMN audience text NOT NULL DEFAULT 'staff'
 CHECK (audience IN ('staff','resident'));
CREATE INDEX user_sessions_audience_active ON atrium.user_sessions
 (user_id,audience,credential_version,expires_at_ms,created_at_ms,id) WHERE revoked_at_ms IS NULL;
ALTER POLICY selected_session ON atrium.user_sessions USING (
 id::text=atrium.context('session_id') AND user_id=atrium.context('actor_user_id')
 AND credential_version::text=atrium.context('credential_version')
 AND audience=coalesce(atrium.context('session_audience'),'staff'));
ALTER POLICY planning_reader_session ON atrium.user_sessions USING (
 user_id=atrium.context('actor_user_id') AND id::text=atrium.context('session_id')
 AND credential_version::text=atrium.context('credential_version')
 AND audience='staff' AND coalesce(atrium.context('session_audience'),'staff')='staff');
GRANT SELECT(audience) ON atrium.user_sessions TO atrium_maintenance_approval_reader;


CREATE OR REPLACE FUNCTION atrium.preserve_user_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Session history is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.audience IS DISTINCT FROM OLD.audience OR NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.credential_version IS DISTINCT FROM OLD.credential_version OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms OR NEW.expires_at_ms IS DISTINCT FROM OLD.expires_at_ms
    OR NEW.last_seen_at_ms < OLD.last_seen_at_ms
    OR (OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms IS DISTINCT FROM OLD.revoked_at_ms) THEN
    RAISE EXCEPTION 'Session identity and lifetime are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION atrium.session_context_valid() RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(atrium.context('session_audience'),'staff') IN ('staff','resident') AND ((atrium.context('session_id') IS NULL AND coalesce(atrium.context('session_audience'),'staff')='staff') OR EXISTS (
    SELECT 1 FROM atrium.user_sessions s WHERE s.id=CASE WHEN atrium.context('session_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN atrium.context('session_id')::uuid END
      AND s.user_id=atrium.context('actor_user_id')
      AND s.credential_version::text=atrium.context('credential_version')
      AND s.audience=coalesce(atrium.context('session_audience'),'staff') AND s.revoked_at_ms IS NULL AND s.expires_at_ms > floor(extract(epoch FROM clock_timestamp())*1000)))
$$;

CREATE OR REPLACE FUNCTION atrium.session_command_context() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(atrium.context('session_audience'),'staff') IN ('staff','resident') AND session_user='atrium_authenticator' AND atrium.context('actor_user_id') IS NOT NULL
    AND atrium.context('credential_version') IS NOT NULL AND atrium.context('login_username') IS NULL
    AND atrium.context('organization_id') IS NULL AND atrium.context('property_id') IS NULL
    AND atrium.context('channel_provider') IS NULL AND atrium.context('channel_external_id') IS NULL
    AND atrium.context('channel_binding_id') IS NULL AND atrium.context('channel_binding_version') IS NULL
$$;

CREATE OR REPLACE FUNCTION atrium.start_user_session(p_id uuid,p_label text) RETURNS SETOF atrium.user_sessions
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
  SELECT count(*) INTO active_count FROM atrium.user_sessions s WHERE s.user_id=actor.id AND s.audience=coalesce(atrium.context('session_audience'),'staff')
    AND s.credential_version=actor.credential_version AND s.revoked_at_ms IS NULL AND s.expires_at_ms>stamp;
  IF active_count>=20 THEN
    FOR victim IN SELECT s.id FROM atrium.user_sessions s WHERE s.user_id=actor.id AND s.audience=coalesce(atrium.context('session_audience'),'staff')
      AND s.credential_version=actor.credential_version AND s.revoked_at_ms IS NULL AND s.expires_at_ms>stamp
      ORDER BY s.created_at_ms,s.id LIMIT active_count-19 FOR UPDATE LOOP
      UPDATE atrium.user_sessions SET revoked_at_ms=greatest(stamp,created_at_ms) WHERE id=victim;
      INSERT INTO atrium.user_session_events(session_id,user_id,operation,reason,at_ms,actor_session_id)
        SELECT id,user_id,'revoked','session_limit',revoked_at_ms,p_id FROM atrium.user_sessions WHERE id=victim;
    END LOOP;
  END IF;
  INSERT INTO atrium.user_sessions(id,user_id,credential_version,label,created_at_ms,last_seen_at_ms,expires_at_ms,audience)
    VALUES(p_id,actor.id,actor.credential_version,p_label,stamp,stamp,stamp+28800000,coalesce(atrium.context('session_audience'),'staff'));
  INSERT INTO atrium.user_session_events(session_id,user_id,operation,reason,at_ms)
    VALUES(p_id,actor.id,'created','sign_in',stamp);
  RETURN QUERY SELECT s.* FROM atrium.user_sessions s WHERE s.id=p_id;
END $$;

CREATE OR REPLACE FUNCTION atrium.resolve_user_session(p_expires_at_ms bigint) RETURNS SETOF atrium.user_sessions
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; stamp bigint; selected atrium.user_sessions%ROWTYPE;
BEGIN
  IF NOT atrium.session_command_context() OR atrium.context('session_id') IS NULL THEN RETURN; END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id=atrium.context('actor_user_id') FOR SHARE;
  IF NOT FOUND OR actor.status<>'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  SELECT s.* INTO selected FROM atrium.user_sessions s WHERE s.id::text=atrium.context('session_id') AND s.user_id=actor.id AND s.audience=coalesce(atrium.context('session_audience'),'staff')
    AND s.credential_version=actor.credential_version AND s.expires_at_ms=p_expires_at_ms AND s.expires_at_ms>stamp AND s.revoked_at_ms IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  IF selected.expires_at_ms<=stamp THEN RETURN; END IF;
  IF stamp-selected.last_seen_at_ms>=60000 THEN
    UPDATE atrium.user_sessions SET last_seen_at_ms=stamp WHERE id=selected.id RETURNING * INTO selected;
  END IF;
  RETURN NEXT selected;
END $$;

CREATE OR REPLACE FUNCTION atrium.list_user_sessions() RETURNS SETOF atrium.user_sessions
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; stamp bigint;
BEGIN
  IF NOT atrium.session_command_context() OR atrium.context('session_id') IS NULL THEN
    RAISE EXCEPTION 'Current session is required' USING ERRCODE='28000'; END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id=atrium.context('actor_user_id') FOR SHARE;
  IF NOT FOUND OR actor.status<>'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version')
    OR NOT atrium.session_context_valid() THEN RAISE EXCEPTION 'Current session is required' USING ERRCODE='28000'; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  RETURN QUERY SELECT s.* FROM atrium.user_sessions s WHERE s.user_id=actor.id AND s.audience=coalesce(atrium.context('session_audience'),'staff') AND s.credential_version=actor.credential_version
    AND s.expires_at_ms>stamp AND s.revoked_at_ms IS NULL ORDER BY s.created_at_ms DESC,s.id;
END $$;

CREATE OR REPLACE FUNCTION atrium.revoke_user_sessions(p_target text) RETURNS TABLE(revoked_ids uuid[],current_revoked boolean)
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
  IF p_target<>'others' AND NOT EXISTS (SELECT 1 FROM atrium.user_sessions s WHERE s.id=p_target::uuid AND s.user_id=actor.id AND s.audience=coalesce(atrium.context('session_audience'),'staff')) THEN
    RAISE EXCEPTION 'Invalid session selection' USING ERRCODE='22023'; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  FOR selected IN SELECT s.* FROM atrium.user_sessions s WHERE s.user_id=actor.id AND s.audience=coalesce(atrium.context('session_audience'),'staff') AND s.credential_version=actor.credential_version
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

CREATE OR REPLACE FUNCTION atrium.staff_context() RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(atrium.context('session_audience'),'staff')='staff' AND atrium.context('actor_user_id') IS NOT NULL AND atrium.context('credential_version') IS NOT NULL AND atrium.context('channel_binding_id') IS NULL
 AND atrium.session_context_valid() AND atrium.mfa_login_allowed()
$$;

CREATE OR REPLACE FUNCTION atrium.channel_context() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(atrium.context('session_audience'),'staff')='staff' AND atrium.context('channel_binding_id') IS NOT NULL AND atrium.context('channel_binding_version') IS NOT NULL
    AND atrium.context('actor_user_id') IS NULL AND atrium.context('credential_version') IS NULL
    AND atrium.context('session_id') IS NULL
$$;

-- Authentication-only self reads remain available; staff directory/catalogue
-- reads require the staff audience without demanding property publication/MFA.
ALTER POLICY auth_membership ON atrium.memberships USING (
 coalesce(atrium.context('session_audience'),'staff')='staff' AND atrium.session_context_valid()
 AND user_id=atrium.context('actor_user_id') AND EXISTS (
 SELECT 1 FROM atrium.users u WHERE u.id=memberships.user_id AND u.status='active'
 AND u.credential_version::text=atrium.context('credential_version')));
ALTER POLICY auth_binding ON atrium.channel_bindings USING (
 coalesce(atrium.context('session_audience'),'staff')='staff' AND atrium.context('session_id') IS NULL AND atrium.context('actor_user_id') IS NULL
 AND atrium.context('credential_version') IS NULL
 AND provider=atrium.context('channel_provider') AND external_id=atrium.context('channel_external_id'));
CREATE OR REPLACE FUNCTION atrium.account_self_context() RETURNS boolean
 LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT atrium.context('actor_user_id') IS NOT NULL AND atrium.context('credential_version') IS NOT NULL
 AND atrium.session_context_valid() AND atrium.mfa_login_allowed()
 AND atrium.context('login_username') IS NULL AND atrium.context('organization_id') IS NULL AND atrium.context('property_id') IS NULL
 AND atrium.context('channel_provider') IS NULL AND atrium.context('channel_external_id') IS NULL
 AND atrium.context('channel_binding_id') IS NULL AND atrium.context('channel_binding_version') IS NULL
$$;

CREATE OR REPLACE FUNCTION atrium.hold_current_session() RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor atrium.users%ROWTYPE; selected atrium.user_sessions%ROWTYPE; stamp bigint;
BEGIN
  IF coalesce(atrium.context('session_audience'),'staff')<>'staff' OR session_user<>'atrium_app' OR atrium.context('actor_user_id') IS NULL
    OR atrium.context('credential_version') IS NULL OR atrium.context('session_id') IS NULL
    OR atrium.context('login_username') IS NOT NULL OR atrium.context('channel_provider') IS NOT NULL
    OR atrium.context('channel_external_id') IS NOT NULL OR atrium.context('channel_binding_id') IS NOT NULL
    OR atrium.context('channel_binding_version') IS NOT NULL THEN RETURN false; END IF;
  SELECT u.* INTO actor FROM atrium.users u WHERE u.id=atrium.context('actor_user_id') FOR SHARE;
  IF NOT FOUND OR actor.status<>'active' OR actor.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN false; END IF;
  SELECT s.* INTO selected FROM atrium.user_sessions s WHERE s.id=CASE
      WHEN atrium.context('session_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN atrium.context('session_id')::uuid END
    AND s.user_id=actor.id AND s.credential_version=actor.credential_version AND s.audience='staff' FOR SHARE;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000);
  RETURN FOUND AND selected.revoked_at_ms IS NULL AND selected.expires_at_ms>stamp AND atrium.mfa_login_allowed();
END $$;

CREATE OR REPLACE FUNCTION atrium.mfa_lock_context(p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE u atrium.users%ROWTYPE; s atrium.user_sessions%ROWTYPE; m atrium.mfa_states%ROWTYPE; stamp bigint;
BEGIN
 IF coalesce(atrium.context('session_audience'),'staff') NOT IN ('staff','resident') OR session_user<>'atrium_authenticator' OR NOT atrium.mfa_uuid(atrium.context('session_id'))
 OR atrium.context('actor_user_id') IS NULL OR atrium.context('credential_version') IS NULL
 OR atrium.context('organization_id') IS NOT NULL OR atrium.context('property_id') IS NOT NULL OR atrium.context('login_username') IS NOT NULL
 OR atrium.context('channel_binding_id') IS NOT NULL OR atrium.context('channel_binding_version') IS NOT NULL
 OR atrium.context('channel_provider') IS NOT NULL OR atrium.context('channel_external_id') IS NOT NULL THEN RETURN atrium.mfa_error('unauthenticated'); END IF;
 SELECT * INTO u FROM atrium.users WHERE id=atrium.context('actor_user_id') FOR UPDATE;
 IF NOT FOUND OR u.status<>'active' OR u.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN atrium.mfa_error('unauthenticated'); END IF;
 SELECT * INTO s FROM atrium.user_sessions WHERE id=atrium.context('session_id')::uuid AND user_id=u.id FOR UPDATE;
 stamp:=atrium.mfa_now();
 IF NOT FOUND OR s.audience IS DISTINCT FROM coalesce(atrium.context('session_audience'),'staff') OR s.revoked_at_ms IS NOT NULL OR s.expires_at_ms<=stamp OR s.credential_version<>u.credential_version THEN RETURN atrium.mfa_error('unauthenticated'); END IF;
 IF p_origin IS NULL OR length(p_origin)>512 OR p_rp_id IS NULL OR length(p_rp_id)>253 OR p_handle !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 INSERT INTO atrium.mfa_states(user_id,origin,rp_id,user_handle) VALUES(u.id,p_origin,p_rp_id,p_handle) ON CONFLICT(user_id) DO NOTHING;
 SELECT * INTO m FROM atrium.mfa_states WHERE user_id=u.id FOR UPDATE;
 IF m.origin<>p_origin OR m.rp_id<>p_rp_id THEN RETURN atrium.mfa_error('state_changed'); END IF;
 UPDATE atrium.mfa_factors SET status='expired',revoked_at_ms=greatest(stamp,created_at_ms) WHERE user_id=u.id AND status='pending' AND pending_expires_at_ms<=stamp;
 RETURN jsonb_build_object('userId',u.id,'sessionId',s.id,'credentialVersion',u.credential_version,'securityVersion',m.security_version,'sessionExpiresAt',s.expires_at_ms,'userHandle',m.user_handle,'everEnabled',m.ever_enabled,'now',stamp);
END $$;

CREATE OR REPLACE FUNCTION atrium.mfa_login_allowed() RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF coalesce(atrium.context('session_audience'),'staff') NOT IN ('staff','resident') THEN RETURN false; END IF;
 IF atrium.context('session_id') IS NULL THEN RETURN coalesce(atrium.context('session_audience'),'staff')='staff'; END IF;
 IF atrium.context('actor_user_id') IS NULL OR atrium.context('credential_version') IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM atrium.user_sessions WHERE id::text=atrium.context('session_id') AND user_id=atrium.context('actor_user_id') AND credential_version::text=atrium.context('credential_version') AND audience=coalesce(atrium.context('session_audience'),'staff') AND revoked_at_ms IS NULL AND expires_at_ms>atrium.mfa_now()) THEN RETURN false; END IF;
 -- Credential-current checks belong to the caller's user policy/admission. This
 -- leaf remains true across the account command's one-version trigger transition.
 RETURN NOT atrium.mfa_required() OR EXISTS(SELECT 1 FROM atrium.mfa_assurances a
 JOIN atrium.mfa_states m ON m.user_id=a.user_id AND m.security_version=a.security_version
 JOIN atrium.mfa_factors f ON f.id=a.factor_id AND f.user_id=a.user_id AND f.status='active'
 WHERE a.user_id=atrium.context('actor_user_id') AND a.session_id::text=atrium.context('session_id')
 AND a.credential_version::text=atrium.context('credential_version') AND a.purpose='session_login' AND a.expires_at_ms>atrium.mfa_now());
END $$;

CREATE OR REPLACE FUNCTION atrium.mfa_proof(p_purpose text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT atrium.mfa_assurance_json(a) FROM atrium.mfa_assurances a
 JOIN atrium.mfa_states m ON m.user_id=a.user_id AND m.security_version=a.security_version
 JOIN atrium.mfa_factors f ON f.id=a.factor_id AND f.user_id=a.user_id AND f.status='active'
 JOIN atrium.user_sessions s ON s.id=a.session_id AND s.user_id=a.user_id AND s.credential_version=a.credential_version
 JOIN atrium.users u ON u.id=a.user_id AND u.status='active' AND u.credential_version=a.credential_version
 WHERE a.user_id=atrium.context('actor_user_id') AND a.session_id::text=atrium.context('session_id')
 AND a.credential_version::text=atrium.context('credential_version') AND a.purpose=p_purpose
 AND s.audience=coalesce(atrium.context('session_audience'),'staff') AND (p_purpose<>'organization_administration' OR s.audience='staff')
 AND s.revoked_at_ms IS NULL AND s.expires_at_ms>atrium.mfa_now() AND a.expires_at_ms>atrium.mfa_now()
 ORDER BY a.verified_at_ms DESC,a.id LIMIT 1
$$;

CREATE OR REPLACE FUNCTION atrium.mfa_hold_proof(p_id uuid,p_purpose text) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u atrium.users%ROWTYPE; s atrium.user_sessions%ROWTYPE; m atrium.mfa_states%ROWTYPE; a atrium.mfa_assurances%ROWTYPE;
BEGIN
 IF coalesce(atrium.context('session_audience'),'staff') NOT IN ('staff','resident') OR (p_purpose='organization_administration' AND coalesce(atrium.context('session_audience'),'staff')<>'staff') OR session_user<>'atrium_app' OR NOT atrium.mfa_uuid(atrium.context('session_id')) OR p_purpose NOT IN ('organization_administration','manage_factors')
 OR atrium.context('channel_binding_id') IS NOT NULL OR atrium.context('channel_binding_version') IS NOT NULL
 OR atrium.context('channel_provider') IS NOT NULL OR atrium.context('channel_external_id') IS NOT NULL
 OR atrium.context('login_username') IS NOT NULL THEN RETURN false; END IF;
 SELECT * INTO u FROM atrium.users WHERE id=atrium.context('actor_user_id') FOR SHARE;
 IF NOT FOUND OR u.status<>'active' OR u.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN false; END IF;
 SELECT * INTO s FROM atrium.user_sessions WHERE id=atrium.context('session_id')::uuid AND user_id=u.id FOR SHARE;
 IF NOT FOUND OR s.audience IS DISTINCT FROM coalesce(atrium.context('session_audience'),'staff') OR s.revoked_at_ms IS NOT NULL OR s.credential_version<>u.credential_version OR s.expires_at_ms<=atrium.mfa_now() THEN RETURN false; END IF;
 SELECT * INTO m FROM atrium.mfa_states WHERE user_id=u.id FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO a FROM atrium.mfa_assurances WHERE id=p_id AND user_id=u.id AND session_id=s.id AND credential_version=u.credential_version AND security_version=m.security_version AND purpose=p_purpose;
 IF NOT FOUND OR a.expires_at_ms<=atrium.mfa_now() THEN RETURN false; END IF;
 PERFORM 1 FROM atrium.mfa_factors WHERE id=a.factor_id AND user_id=u.id AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM atrium.mfa_assurances WHERE id=a.id AND expires_at_ms>atrium.mfa_now() FOR SHARE;
 RETURN FOUND AND atrium.mfa_login_allowed();
END $$;

CREATE OR REPLACE FUNCTION atrium.mfa_challenge_authority(c atrium.mfa_challenges) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m atrium.mfa_states%ROWTYPE; a jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM atrium.user_sessions s WHERE s.id=c.session_id AND s.user_id=c.user_id
 AND s.credential_version=c.credential_version AND s.audience=coalesce(atrium.context('session_audience'),'staff')
 AND s.id::text=atrium.context('session_id') AND s.user_id=atrium.context('actor_user_id')
 AND s.credential_version::text=atrium.context('credential_version')
 AND s.revoked_at_ms IS NULL AND s.expires_at_ms>atrium.mfa_now()
 AND (c.purpose<>'organization_administration' OR s.audience='staff')) THEN RETURN false; END IF;
 SELECT * INTO m FROM atrium.mfa_states WHERE user_id=c.user_id;
 IF NOT FOUND OR m.security_version<>c.security_version OR c.expires_at_ms<=atrium.mfa_now() THEN RETURN false; END IF;
 IF c.intent='verify' THEN RETURN true; END IF;
 IF c.intent='recover_factor' THEN
  RETURN EXISTS(SELECT 1 FROM atrium.mfa_recovery_grants g WHERE g.id=c.recovery_grant_id AND g.user_id=c.user_id AND g.session_id=c.session_id
   AND g.credential_version=c.credential_version AND g.security_version=c.security_version AND g.expires_at_ms>atrium.mfa_now()
   AND g.reauthentication_id=c.reauthentication_id AND atrium.mfa_reauth(c.reauthentication_id,c.security_version,g.id)
   AND (g.consumed_by IS NULL OR g.consumed_by=c.id OR g.consumed_by=(SELECT pending_challenge_id FROM atrium.mfa_factors WHERE id=c.factor_id)));
 END IF;
 IF NOT atrium.mfa_reauth(c.reauthentication_id,c.security_version,coalesce((SELECT pending_challenge_id FROM atrium.mfa_factors WHERE id=c.factor_id),c.id)) THEN RETURN false; END IF;
 IF c.intent='bootstrap' THEN RETURN NOT m.ever_enabled AND NOT EXISTS(SELECT 1 FROM atrium.mfa_factors WHERE user_id=c.user_id AND status='active'); END IF;
 SELECT atrium.mfa_assurance_json(p) INTO a FROM atrium.mfa_assurances p JOIN atrium.mfa_factors f ON f.id=p.factor_id AND f.user_id=p.user_id AND f.status='active'
 WHERE p.id=c.manage_proof_id AND p.user_id=c.user_id AND p.session_id=c.session_id AND p.credential_version=c.credential_version
 AND p.security_version=c.security_version AND p.purpose='manage_factors' AND p.expires_at_ms>atrium.mfa_now();
 RETURN a IS NOT NULL;
END $$;

CREATE OR REPLACE FUNCTION atrium.mfa_begin_ceremony(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; c atrium.mfa_challenges%ROWTYPE; pending atrium.mfa_factors%ROWTYPE; proof jsonb; charged jsonb; grant_row atrium.mfa_recovery_grants%ROWTYPE; reauth uuid; target uuid; grant_id uuid; intent text; expiry bigint;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['id','challengeHash','kind','intent','purpose','expectedSecurityVersion','label','reauthenticationId','factorId','recoveryGrantId']::text[]) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid;

 IF NOT atrium.mfa_uuid(p_input->>'id') OR coalesce(p_input->>'challengeHash','')!~'^[0-9a-f]{64}$'
 OR coalesce(p_input->>'kind','') NOT IN ('registration','authentication') OR coalesce(p_input->>'intent','') NOT IN ('bootstrap','add_factor','recover_factor','verify')
 OR coalesce(p_input->>'purpose','') NOT IN ('session_login','organization_administration','manage_factors')
 OR (p_input->>'expectedSecurityVersion')::bigint IS DISTINCT FROM security
 OR ((p_input->>'reauthenticationId') IS NOT NULL AND NOT atrium.mfa_uuid(p_input->>'reauthenticationId'))
 OR ((p_input->>'factorId') IS NOT NULL AND NOT atrium.mfa_uuid(p_input->>'factorId'))
 OR ((p_input->>'recoveryGrantId') IS NOT NULL AND NOT atrium.mfa_uuid(p_input->>'recoveryGrantId')) THEN RETURN atrium.mfa_error('state_changed'); END IF;
 IF p_input->>'purpose'='organization_administration' AND coalesce(atrium.context('session_audience'),'staff')<>'staff' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 IF EXISTS(SELECT 1 FROM atrium.mfa_challenges WHERE id=(p_input->>'id')::uuid) THEN RETURN atrium.mfa_error('challenge_used'); END IF;
 charged:=atrium.mfa_charge('ceremony',(p_input->>'id')::uuid,60); IF charged IS NOT NULL THEN RETURN charged; END IF;
 reauth:=(p_input->>'reauthenticationId')::uuid; target:=(p_input->>'factorId')::uuid; grant_id:=(p_input->>'recoveryGrantId')::uuid;
 intent:=p_input->>'intent'; expiry:=least(stamp+300000,(ctx->>'sessionExpiresAt')::bigint);
 IF p_input->>'kind'='registration' THEN
  IF intent='verify' OR p_input->>'purpose'<>'session_login' OR target IS NOT NULL OR p_input->>'label' IS NULL OR length(p_input->>'label') NOT BETWEEN 1 AND 80 OR (p_input->>'label')~'[[:cntrl:]]' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
  IF intent='recover_factor' THEN
   SELECT * INTO grant_row FROM atrium.mfa_recovery_grants WHERE id=grant_id AND user_id=actor AND session_id=sid FOR UPDATE;
   IF NOT FOUND OR grant_row.security_version<>security OR grant_row.credential_version<>(ctx->>'credentialVersion')::bigint OR grant_row.expires_at_ms<=stamp OR grant_row.consumed_by IS NOT NULL
    OR grant_row.reauthentication_id IS DISTINCT FROM reauth OR NOT atrium.mfa_reauth(reauth,security,grant_id) THEN RETURN atrium.mfa_error('recovery_failed'); END IF;
   -- Lost keys must not prevent recovery at the ordinary ten-factor limit.
   -- Only one temporary recovery replacement may await its activation assertion.
   IF (SELECT count(*) FROM atrium.mfa_factors WHERE user_id=actor AND status IN ('pending','active'))>=11
    OR EXISTS(SELECT 1 FROM atrium.mfa_factors WHERE user_id=actor AND status='pending' AND pending_intent='recover_factor') THEN RETURN atrium.mfa_error('factor_limit'); END IF;
   expiry:=least(expiry,grant_row.expires_at_ms);
  ELSE
   IF (SELECT count(*) FROM atrium.mfa_factors WHERE user_id=actor AND status IN ('pending','active'))>=10 THEN RETURN atrium.mfa_error('factor_limit'); END IF;
   IF grant_id IS NOT NULL OR NOT atrium.mfa_reauth(reauth,security) THEN RETURN atrium.mfa_error('reauthentication_required'); END IF;
   IF intent='bootstrap' THEN
    IF (ctx->>'everEnabled')::boolean OR EXISTS(SELECT 1 FROM atrium.mfa_factors WHERE user_id=actor AND status IN ('active','pending')) THEN RETURN atrium.mfa_error('state_changed'); END IF;
   ELSE
    proof:=atrium.mfa_proof('manage_factors'); IF proof IS NULL THEN RETURN atrium.mfa_error('mfa_required'); END IF;
    expiry:=least(expiry,(proof->>'expiresAt')::bigint);
   END IF;
   expiry:=least(expiry,(SELECT expires_at_ms FROM atrium.mfa_password_checks WHERE id=reauth));
   UPDATE atrium.mfa_password_checks SET consumed_by=(p_input->>'id')::uuid WHERE id=reauth;
  END IF;
 ELSE
  IF intent<>'verify' OR p_input->>'label' IS NOT NULL OR reauth IS NOT NULL OR grant_id IS NOT NULL THEN RETURN atrium.mfa_error('invalid_input'); END IF;
  IF target IS NOT NULL THEN
   SELECT * INTO pending FROM atrium.mfa_factors WHERE id=target AND user_id=actor AND status IN ('active','pending') FOR UPDATE;
   IF NOT FOUND THEN RETURN atrium.mfa_error('verification_failed'); END IF;
   IF pending.status='pending' THEN
    IF pending.pending_session_id<>sid OR p_input->>'purpose'<>'session_login' OR pending.pending_expires_at_ms<=stamp THEN RETURN atrium.mfa_error('verification_failed'); END IF;
    intent:=pending.pending_intent; reauth:=pending.reauthentication_id; grant_id:=pending.recovery_grant_id;
    proof:=CASE WHEN pending.manage_proof_id IS NOT NULL THEN jsonb_build_object('id',pending.manage_proof_id) ELSE NULL END;
    expiry:=least(expiry,pending.pending_expires_at_ms);
   END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM atrium.mfa_factors WHERE user_id=actor AND status='active') THEN RETURN atrium.mfa_error('verification_failed'); END IF;
 END IF;
 INSERT INTO atrium.mfa_challenges(id,user_id,session_id,credential_version,security_version,challenge_hash,kind,intent,purpose,origin,rp_id,label,factor_id,reauthentication_id,manage_proof_id,recovery_grant_id,created_at_ms,expires_at_ms)
 VALUES((p_input->>'id')::uuid,actor,sid,(ctx->>'credentialVersion')::bigint,security,p_input->>'challengeHash',p_input->>'kind',intent,p_input->>'purpose',p_origin,p_rp_id,p_input->>'label',target,reauth,(proof->>'id')::uuid,grant_id,stamp,expiry) RETURNING * INTO c;
 IF NOT atrium.mfa_challenge_authority(c) THEN
  RETURN atrium.mfa_error('reauthentication_required');
 END IF;
 RETURN jsonb_build_object('id',c.id,'expiresAt',expiry,'securityVersion',security);
END $$;

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
      'atrium.channel_binding_version', 'atrium.session_id', 'atrium.session_audience']) AS setting(name)
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
