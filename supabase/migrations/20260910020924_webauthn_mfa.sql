-- WebAuthn MFA uses public keys only. This migration never enrolls a real user.
-- Provision atrium_mfa_executor NOLOGIN/NOBYPASSRLS before applying.
SET LOCAL ROLE atrium_admin;
CREATE TABLE atrium.mfa_states (
 user_id atrium.record_id PRIMARY KEY REFERENCES atrium.users(id),
 origin text NOT NULL CHECK(length(origin) BETWEEN 1 AND 512),
 rp_id text NOT NULL CHECK(length(rp_id) BETWEEN 1 AND 253),
 user_handle text NOT NULL UNIQUE CHECK(user_handle ~ '^[A-Za-z0-9_-]{43}$'),
 security_version atrium.positive_version NOT NULL DEFAULT 1,
 ever_enabled boolean NOT NULL DEFAULT false,
 UNIQUE(user_id,rp_id)
);
CREATE TABLE atrium.mfa_password_checks (
 id uuid PRIMARY KEY, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), session_id uuid NOT NULL,
 credential_version atrium.positive_version NOT NULL, security_version atrium.positive_version NOT NULL,
 hash_fingerprint bytea NOT NULL CHECK(octet_length(hash_fingerprint)=32),
 created_at_ms bigint NOT NULL, expires_at_ms bigint NOT NULL, verified_at_ms bigint, consumed_by uuid,
 FOREIGN KEY(session_id,user_id) REFERENCES atrium.user_sessions(id,user_id),
 CHECK(created_at_ms>0 AND expires_at_ms>created_at_ms AND expires_at_ms<=created_at_ms+300000)
);
CREATE INDEX mfa_password_checks_user ON atrium.mfa_password_checks(user_id,created_at_ms,id);
CREATE TABLE atrium.mfa_factors (
 id uuid PRIMARY KEY, user_id atrium.record_id NOT NULL, rp_id text NOT NULL,
 credential_id text NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 1364 AND credential_id ~ '^[A-Za-z0-9_-]+$'),
 public_key text NOT NULL CHECK(length(public_key) BETWEEN 1 AND 22000 AND public_key ~ '^[A-Za-z0-9_-]+$'),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80 AND label !~ '[[:cntrl:]]'),
 counter bigint NOT NULL CHECK(counter BETWEEN 0 AND 4294967295), counter_revision atrium.positive_version NOT NULL DEFAULT 1,
 status text NOT NULL CHECK(status IN ('pending','active','revoked','expired')),
 backup_eligible boolean NOT NULL, backed_up boolean NOT NULL CHECK(NOT backed_up OR backup_eligible),
 transports text[] NOT NULL CHECK(cardinality(transports)<=8),
 created_at_ms bigint NOT NULL, last_used_at_ms bigint, revoked_at_ms bigint,
 pending_session_id uuid NOT NULL, pending_intent text NOT NULL CHECK(pending_intent IN ('bootstrap','add_factor','recover_factor')),
 pending_expires_at_ms bigint NOT NULL, pending_challenge_id uuid NOT NULL,
 reauthentication_id uuid, manage_proof_id uuid, recovery_grant_id uuid,
 UNIQUE(id,user_id), UNIQUE(rp_id,credential_id),
 FOREIGN KEY(user_id,rp_id) REFERENCES atrium.mfa_states(user_id,rp_id),
 FOREIGN KEY(pending_session_id,user_id) REFERENCES atrium.user_sessions(id,user_id),
 CHECK(created_at_ms>0 AND pending_expires_at_ms>created_at_ms AND pending_expires_at_ms<=created_at_ms+300000),
 CHECK(last_used_at_ms IS NULL OR last_used_at_ms>=created_at_ms)
);
CREATE INDEX mfa_factors_user ON atrium.mfa_factors(user_id,status,id);
CREATE TABLE atrium.mfa_assurances (
 id uuid PRIMARY KEY, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), session_id uuid NOT NULL,
 credential_version atrium.positive_version NOT NULL, security_version atrium.positive_version NOT NULL,
 factor_id uuid NOT NULL, purpose text NOT NULL CHECK(purpose IN ('session_login','organization_administration','manage_factors')),
 verified_at_ms bigint NOT NULL, expires_at_ms bigint NOT NULL,
 FOREIGN KEY(session_id,user_id) REFERENCES atrium.user_sessions(id,user_id),
 FOREIGN KEY(factor_id,user_id) REFERENCES atrium.mfa_factors(id,user_id),
 CHECK(verified_at_ms>0 AND expires_at_ms>verified_at_ms AND (purpose='session_login' OR expires_at_ms<=verified_at_ms+600000))
);
CREATE INDEX mfa_assurances_session ON atrium.mfa_assurances(user_id,session_id,purpose,expires_at_ms);
CREATE TABLE atrium.mfa_recovery_codes (
 id uuid PRIMARY KEY, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), generation_id uuid NOT NULL,
 code_hash text NOT NULL CHECK(code_hash ~ '^[0-9a-f]{64}$'), created_at_ms bigint NOT NULL,
 consumed_by uuid, revoked_at_ms bigint, UNIQUE(user_id,code_hash)
);
CREATE INDEX mfa_recovery_codes_user ON atrium.mfa_recovery_codes(user_id,generation_id,id);
CREATE TABLE atrium.mfa_recovery_grants (
 id uuid PRIMARY KEY, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), session_id uuid NOT NULL,
 credential_version atrium.positive_version NOT NULL, security_version atrium.positive_version NOT NULL,
 created_at_ms bigint NOT NULL, expires_at_ms bigint NOT NULL, consumed_by uuid, reauthentication_id uuid NOT NULL REFERENCES atrium.mfa_password_checks(id),
 FOREIGN KEY(session_id,user_id) REFERENCES atrium.user_sessions(id,user_id),
 CHECK(created_at_ms>0 AND expires_at_ms>created_at_ms AND expires_at_ms<=created_at_ms+300000)
);
CREATE TABLE atrium.mfa_challenges (
 id uuid PRIMARY KEY, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), session_id uuid NOT NULL,
 credential_version atrium.positive_version NOT NULL, security_version atrium.positive_version NOT NULL,
 challenge_hash text NOT NULL CHECK(challenge_hash ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL CHECK(kind IN ('registration','authentication')),
 intent text NOT NULL CHECK(intent IN ('bootstrap','add_factor','recover_factor','verify')),
 purpose text NOT NULL CHECK(purpose IN ('session_login','organization_administration','manage_factors')),
 origin text NOT NULL, rp_id text NOT NULL, label text, factor_id uuid,
 reauthentication_id uuid, manage_proof_id uuid, recovery_grant_id uuid,
 created_at_ms bigint NOT NULL, expires_at_ms bigint NOT NULL,
 status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','claimed','rejected','complete')),
 attempt_id uuid UNIQUE, response_digest text CHECK(response_digest ~ '^[0-9a-f]{64}$'),
 claimed_factor_id uuid, claimed_counter bigint, claimed_counter_revision bigint, receipt jsonb,
 FOREIGN KEY(session_id,user_id) REFERENCES atrium.user_sessions(id,user_id),
 FOREIGN KEY(factor_id,user_id) REFERENCES atrium.mfa_factors(id,user_id),
 FOREIGN KEY(claimed_factor_id,user_id) REFERENCES atrium.mfa_factors(id,user_id),
 CHECK(created_at_ms>0 AND expires_at_ms>created_at_ms AND expires_at_ms<=created_at_ms+300000),
 CHECK((status='ready' AND attempt_id IS NULL AND response_digest IS NULL) OR (status<>'ready' AND attempt_id IS NOT NULL AND response_digest IS NOT NULL)),
 CHECK((status='complete')=(receipt IS NOT NULL))
);
CREATE INDEX mfa_challenges_user ON atrium.mfa_challenges(user_id,created_at_ms,id);
CREATE TABLE atrium.mfa_attempts (
 id uuid PRIMARY KEY, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id),
 kind text NOT NULL CHECK(kind IN ('password','ceremony','recovery')), at_ms bigint NOT NULL CHECK(at_ms>0)
);
CREATE INDEX mfa_attempts_user_window ON atrium.mfa_attempts(user_id,kind,at_ms);
CREATE TABLE atrium.mfa_requests (
 id uuid PRIMARY KEY, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), session_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('factor.revoke','recovery.rotate','recovery.redeem')),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'), result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 at_ms bigint NOT NULL, FOREIGN KEY(session_id,user_id) REFERENCES atrium.user_sessions(id,user_id)
);
CREATE TABLE atrium.mfa_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), session_id uuid NOT NULL,
 credential_version atrium.positive_version NOT NULL, security_version atrium.positive_version NOT NULL,
 operation text NOT NULL CHECK(operation IN ('password.verified','challenge.claimed','challenge.rejected','factor.pending','factor.activated','factor.revoked','assurance.verified','recovery.rotated','recovery.redeemed','recovery.replaced')),
 subject_id uuid NOT NULL, at_ms bigint NOT NULL CHECK(at_ms>0),
 FOREIGN KEY(session_id,user_id) REFERENCES atrium.user_sessions(id,user_id)
);
CREATE INDEX mfa_events_user_time ON atrium.mfa_events(user_id,at_ms,id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mfa_states','mfa_password_checks','mfa_factors','mfa_assurances','mfa_recovery_codes','mfa_recovery_grants','mfa_challenges','mfa_attempts','mfa_requests','mfa_events'] LOOP
  EXECUTE format('ALTER TABLE atrium.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE atrium.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON atrium.%I FROM PUBLIC,atrium_app,atrium_authenticator',t);
  EXECUTE format('CREATE POLICY maintenance ON atrium.%I TO atrium_admin USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY mfa_self ON atrium.%I TO atrium_mfa_executor USING(user_id=atrium.context(''actor_user_id'')) WITH CHECK(user_id=atrium.context(''actor_user_id''))',t);
 END LOOP;
END $$;
CREATE POLICY mfa_identity ON atrium.users FOR SELECT TO atrium_mfa_executor USING(id=atrium.context('actor_user_id'));
CREATE POLICY mfa_identity_lock ON atrium.users FOR UPDATE TO atrium_mfa_executor USING(id=atrium.context('actor_user_id')) WITH CHECK(false);
CREATE POLICY mfa_membership ON atrium.memberships FOR SELECT TO atrium_mfa_executor USING(user_id=atrium.context('actor_user_id'));
CREATE POLICY mfa_password ON atrium.user_credentials FOR SELECT TO atrium_mfa_executor USING(user_id=atrium.context('actor_user_id'));
CREATE POLICY mfa_sessions ON atrium.user_sessions TO atrium_mfa_executor USING(user_id=atrium.context('actor_user_id')) WITH CHECK(user_id=atrium.context('actor_user_id'));
CREATE POLICY mfa_session_event ON atrium.user_session_events FOR INSERT TO atrium_mfa_executor WITH CHECK(user_id=atrium.context('actor_user_id'));

CREATE FUNCTION atrium.mfa_now() RETURNS bigint LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog
 AS $$ SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint $$;
CREATE FUNCTION atrium.mfa_error(code text,retry integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog
 AS $$ SELECT jsonb_strip_nulls(jsonb_build_object('error',code,'retryAfterSeconds',retry)) $$;
CREATE FUNCTION atrium.mfa_uuid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog
 AS $$ SELECT coalesce(value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false) $$;
CREATE FUNCTION atrium.mfa_factor_json(f atrium.mfa_factors) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',f.id,'label',f.label,'credentialId',f.credential_id,'publicKey',f.public_key,'counter',f.counter,'counterRevision',f.counter_revision,
 'status',f.status,'backupEligible',f.backup_eligible,'backedUp',f.backed_up,'transports',to_jsonb(f.transports),'createdAt',f.created_at_ms,'lastUsedAt',f.last_used_at_ms)
$$;
CREATE FUNCTION atrium.mfa_assurance_json(a atrium.mfa_assurances) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',a.id,'userId',a.user_id,'sessionId',a.session_id,'credentialVersion',a.credential_version,'securityVersion',a.security_version,
 'factorId',a.factor_id,'purpose',a.purpose,'verifiedAt',a.verified_at_ms,'expiresAt',a.expires_at_ms)
$$;
CREATE FUNCTION atrium.mfa_required() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM atrium.mfa_states WHERE user_id=atrium.context('actor_user_id') AND ever_enabled)
 OR EXISTS(SELECT 1 FROM atrium.memberships WHERE user_id=atrium.context('actor_user_id') AND status='active' AND role IN ('owner','admin','staff'))
$$;
CREATE FUNCTION atrium.mfa_proof(p_purpose text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT atrium.mfa_assurance_json(a) FROM atrium.mfa_assurances a
 JOIN atrium.mfa_states m ON m.user_id=a.user_id AND m.security_version=a.security_version
 JOIN atrium.mfa_factors f ON f.id=a.factor_id AND f.user_id=a.user_id AND f.status='active'
 JOIN atrium.user_sessions s ON s.id=a.session_id AND s.user_id=a.user_id AND s.credential_version=a.credential_version
 JOIN atrium.users u ON u.id=a.user_id AND u.status='active' AND u.credential_version=a.credential_version
 WHERE a.user_id=atrium.context('actor_user_id') AND a.session_id::text=atrium.context('session_id')
 AND a.credential_version::text=atrium.context('credential_version') AND a.purpose=p_purpose
 AND s.revoked_at_ms IS NULL AND s.expires_at_ms>atrium.mfa_now() AND a.expires_at_ms>atrium.mfa_now()
 ORDER BY a.verified_at_ms DESC,a.id LIMIT 1
$$;
CREATE FUNCTION atrium.mfa_lock_context(p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE u atrium.users%ROWTYPE; s atrium.user_sessions%ROWTYPE; m atrium.mfa_states%ROWTYPE; stamp bigint;
BEGIN
 IF session_user<>'atrium_authenticator' OR NOT atrium.mfa_uuid(atrium.context('session_id'))
 OR atrium.context('actor_user_id') IS NULL OR atrium.context('credential_version') IS NULL
 OR atrium.context('organization_id') IS NOT NULL OR atrium.context('property_id') IS NOT NULL OR atrium.context('login_username') IS NOT NULL
 OR atrium.context('channel_binding_id') IS NOT NULL OR atrium.context('channel_binding_version') IS NOT NULL
 OR atrium.context('channel_provider') IS NOT NULL OR atrium.context('channel_external_id') IS NOT NULL THEN RETURN atrium.mfa_error('unauthenticated'); END IF;
 SELECT * INTO u FROM atrium.users WHERE id=atrium.context('actor_user_id') FOR UPDATE;
 IF NOT FOUND OR u.status<>'active' OR u.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN atrium.mfa_error('unauthenticated'); END IF;
 SELECT * INTO s FROM atrium.user_sessions WHERE id=atrium.context('session_id')::uuid AND user_id=u.id FOR UPDATE;
 stamp:=atrium.mfa_now();
 IF NOT FOUND OR s.revoked_at_ms IS NOT NULL OR s.expires_at_ms<=stamp OR s.credential_version<>u.credential_version THEN RETURN atrium.mfa_error('unauthenticated'); END IF;
 IF p_origin IS NULL OR length(p_origin)>512 OR p_rp_id IS NULL OR length(p_rp_id)>253 OR p_handle !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 INSERT INTO atrium.mfa_states(user_id,origin,rp_id,user_handle) VALUES(u.id,p_origin,p_rp_id,p_handle) ON CONFLICT(user_id) DO NOTHING;
 SELECT * INTO m FROM atrium.mfa_states WHERE user_id=u.id FOR UPDATE;
 IF m.origin<>p_origin OR m.rp_id<>p_rp_id THEN RETURN atrium.mfa_error('state_changed'); END IF;
 UPDATE atrium.mfa_factors SET status='expired',revoked_at_ms=greatest(stamp,created_at_ms) WHERE user_id=u.id AND status='pending' AND pending_expires_at_ms<=stamp;
 RETURN jsonb_build_object('userId',u.id,'sessionId',s.id,'credentialVersion',u.credential_version,'securityVersion',m.security_version,'sessionExpiresAt',s.expires_at_ms,'userHandle',m.user_handle,'everEnabled',m.ever_enabled,'now',stamp);
END $$;
CREATE FUNCTION atrium.mfa_charge(p_kind text,p_id uuid,p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE stamp bigint:=atrium.mfa_now(); n integer; first_time bigint; retry numeric;
BEGIN
 SELECT count(*)::int,min(at_ms) INTO n,first_time FROM atrium.mfa_attempts WHERE user_id=atrium.context('actor_user_id') AND kind=p_kind AND at_ms>stamp-900000;
 IF n>=p_limit THEN
  retry:=greatest(1,ceil((first_time+900000-stamp)::numeric/1000));
  IF retry>2147483647 THEN RETURN atrium.mfa_error('mfa_unavailable'); END IF;
  RETURN atrium.mfa_error('rate_limited',retry::integer);
 END IF;
 INSERT INTO atrium.mfa_attempts(id,user_id,kind,at_ms) VALUES(p_id,atrium.context('actor_user_id'),p_kind,stamp);
 -- Own-user cleanup is bounded by the admitted rolling budgets; other histories are retained.
 DELETE FROM atrium.mfa_attempts WHERE user_id=atrium.context('actor_user_id') AND at_ms<=stamp-900000;
 RETURN NULL;
END $$;
CREATE FUNCTION atrium.mfa_audit(p_operation text,p_subject uuid,p_version bigint) RETURNS void LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 INSERT INTO atrium.mfa_events(user_id,session_id,credential_version,security_version,operation,subject_id,at_ms)
 VALUES(atrium.context('actor_user_id'),atrium.context('session_id')::uuid,atrium.context('credential_version')::bigint,p_version,p_operation,p_subject,atrium.mfa_now())
$$;
CREATE FUNCTION atrium.mfa_reauth(p_id uuid,p_security bigint,p_consumer uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM atrium.mfa_password_checks p WHERE p.id=p_id AND p.user_id=atrium.context('actor_user_id') AND p.session_id::text=atrium.context('session_id')
 AND p.credential_version::text=atrium.context('credential_version') AND p.security_version=p_security AND p.verified_at_ms IS NOT NULL AND p.expires_at_ms>atrium.mfa_now()
 AND (p.consumed_by IS NULL OR p.consumed_by=p_consumer))
$$;
CREATE FUNCTION atrium.mfa_challenge_authority(c atrium.mfa_challenges) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m atrium.mfa_states%ROWTYPE; a jsonb;
BEGIN
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

CREATE FUNCTION atrium.mfa_keys(p jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(p)='object' AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT k=ANY(keys)),false)
$$;

CREATE FUNCTION atrium.mfa_read_state(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; factors jsonb; proofs jsonb; remaining integer;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY[]::text[]) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid;

 SELECT coalesce(jsonb_agg(atrium.mfa_factor_json(f) ORDER BY f.created_at_ms,f.id),'[]'::jsonb) INTO factors FROM atrium.mfa_factors f WHERE user_id=actor AND status IN ('active','pending');
 SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO proofs FROM (SELECT atrium.mfa_proof(purpose) value FROM unnest(ARRAY['session_login','organization_administration','manage_factors']) purpose) p WHERE value IS NOT NULL;
 SELECT count(*)::int INTO remaining FROM atrium.mfa_recovery_codes WHERE user_id=actor AND consumed_by IS NULL AND revoked_at_ms IS NULL;
 RETURN jsonb_build_object('userId',actor,'sessionId',sid,'credentialVersion',(ctx->>'credentialVersion')::bigint,'securityVersion',security,'userHandle',ctx->>'userHandle','everEnabled',(ctx->>'everEnabled')::boolean,'required',atrium.mfa_required(),'factors',factors,'assurances',proofs,'recoveryRemaining',remaining);
END $$;

CREATE FUNCTION atrium.mfa_reserve_password(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; request uuid; charged jsonb; current_hash text; expiry bigint;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['id']::text[]) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid;

 IF NOT atrium.mfa_uuid(p_input->>'id') THEN RETURN atrium.mfa_error('invalid_input'); END IF; request:=(p_input->>'id')::uuid;
 IF EXISTS(SELECT 1 FROM atrium.mfa_password_checks WHERE id=request) THEN RETURN atrium.mfa_error('challenge_used'); END IF;
 charged:=atrium.mfa_charge('password',request,10); IF charged IS NOT NULL THEN RETURN charged; END IF;
 SELECT password_hash INTO current_hash FROM atrium.user_credentials WHERE user_id=actor;
 IF NOT FOUND THEN RETURN atrium.mfa_error('unauthenticated'); END IF;
 expiry:=least(stamp+300000,(ctx->>'sessionExpiresAt')::bigint);
 INSERT INTO atrium.mfa_password_checks(id,user_id,session_id,credential_version,security_version,hash_fingerprint,created_at_ms,expires_at_ms)
 VALUES(request,actor,sid,(ctx->>'credentialVersion')::bigint,security,sha256(convert_to(current_hash,'UTF8')),stamp,expiry);
 RETURN jsonb_build_object('id',request,'userId',actor,'sessionId',sid,'credentialVersion',(ctx->>'credentialVersion')::bigint,'securityVersion',security,'passwordHash',current_hash,'expiresAt',expiry);
END $$;

CREATE FUNCTION atrium.mfa_complete_password(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; check_row atrium.mfa_password_checks%ROWTYPE; current_hash text;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['id','passwordHash']::text[]) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid;

 IF NOT atrium.mfa_uuid(p_input->>'id') OR jsonb_typeof(p_input->'passwordHash')<>'string' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 SELECT * INTO check_row FROM atrium.mfa_password_checks WHERE id=(p_input->>'id')::uuid AND user_id=actor AND session_id=sid FOR UPDATE;
 IF NOT FOUND OR check_row.credential_version<>(ctx->>'credentialVersion')::bigint OR check_row.security_version<>security OR check_row.expires_at_ms<=atrium.mfa_now() OR check_row.consumed_by IS NOT NULL THEN RETURN atrium.mfa_error('reauthentication_required'); END IF;
 SELECT password_hash INTO current_hash FROM atrium.user_credentials WHERE user_id=actor;
 IF NOT FOUND OR sha256(convert_to(current_hash,'UTF8'))<>check_row.hash_fingerprint OR current_hash IS DISTINCT FROM p_input->>'passwordHash' THEN RETURN atrium.mfa_error('reauthentication_required'); END IF;
 IF check_row.verified_at_ms IS NULL THEN
  UPDATE atrium.mfa_password_checks SET verified_at_ms=stamp WHERE id=check_row.id;
  PERFORM atrium.mfa_audit('password.verified',check_row.id,security);
 END IF;
 RETURN jsonb_build_object('id',check_row.id,'securityVersion',security,'expiresAt',check_row.expires_at_ms);
END $$;

CREATE FUNCTION atrium.mfa_begin_ceremony(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
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

CREATE FUNCTION atrium.mfa_claim_ceremony(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; c atrium.mfa_challenges%ROWTYPE; f atrium.mfa_factors%ROWTYPE; factor_json jsonb;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['challengeId','attemptId','responseDigest','credentialId']::text[]) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid;

 IF NOT atrium.mfa_uuid(p_input->>'challengeId') OR NOT atrium.mfa_uuid(p_input->>'attemptId') OR coalesce(p_input->>'responseDigest','')!~'^[0-9a-f]{64}$' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 SELECT * INTO c FROM atrium.mfa_challenges WHERE id=(p_input->>'challengeId')::uuid AND user_id=actor AND session_id=sid FOR UPDATE;
 IF NOT FOUND THEN RETURN atrium.mfa_error('verification_failed'); END IF;
 IF c.status<>'ready' THEN RETURN atrium.mfa_error('challenge_used'); END IF;
 IF c.expires_at_ms<=atrium.mfa_now() THEN RETURN atrium.mfa_error('challenge_expired'); END IF;
 IF c.credential_version<>(ctx->>'credentialVersion')::bigint OR c.security_version<>security OR c.origin<>p_origin OR c.rp_id<>p_rp_id THEN RETURN atrium.mfa_error('state_changed'); END IF;
 -- Claim before returning any verifier material; every attempted response is one-use.
 UPDATE atrium.mfa_challenges SET status='claimed',attempt_id=(p_input->>'attemptId')::uuid,response_digest=p_input->>'responseDigest' WHERE id=c.id;
 PERFORM atrium.mfa_audit('challenge.claimed',c.id,security);
 IF NOT atrium.mfa_challenge_authority(c) THEN
  UPDATE atrium.mfa_challenges SET status='rejected' WHERE id=c.id;
  RETURN atrium.mfa_error('reauthentication_required');
 END IF;
 IF c.kind='authentication' THEN
  SELECT * INTO f FROM atrium.mfa_factors WHERE user_id=actor AND rp_id=p_rp_id AND credential_id=p_input->>'credentialId'
   AND (c.factor_id IS NULL OR id=c.factor_id) AND (status='active' OR (status='pending' AND id=c.factor_id AND pending_session_id=sid AND c.intent<>'verify')) FOR UPDATE;
  IF NOT FOUND THEN UPDATE atrium.mfa_challenges SET status='rejected' WHERE id=c.id; RETURN atrium.mfa_error('verification_failed'); END IF;
  UPDATE atrium.mfa_challenges SET claimed_factor_id=f.id,claimed_counter=f.counter,claimed_counter_revision=f.counter_revision WHERE id=c.id;
  factor_json:=atrium.mfa_factor_json(f);
 END IF;
 RETURN jsonb_build_object('id',c.id,'attemptId',p_input->>'attemptId','responseDigest',p_input->>'responseDigest','challengeHash',c.challenge_hash,
 'userId',actor,'sessionId',sid,'credentialVersion',c.credential_version,'securityVersion',security,'kind',c.kind,'intent',c.intent,'purpose',c.purpose,'origin',c.origin,'rpId',c.rp_id,'userHandle',ctx->>'userHandle','expiresAt',c.expires_at_ms,'factor',factor_json);
END $$;

CREATE FUNCTION atrium.mfa_reject_ceremony(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; c atrium.mfa_challenges%ROWTYPE;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['id','attemptId','responseDigest']::text[]) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid;

 IF NOT atrium.mfa_uuid(p_input->>'id') OR NOT atrium.mfa_uuid(p_input->>'attemptId') OR coalesce(p_input->>'responseDigest','')!~'^[0-9a-f]{64}$' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 SELECT * INTO c FROM atrium.mfa_challenges WHERE id=(p_input->>'id')::uuid AND user_id=actor AND session_id=sid FOR UPDATE;
 IF NOT FOUND OR c.attempt_id IS DISTINCT FROM (p_input->>'attemptId')::uuid OR c.response_digest IS DISTINCT FROM p_input->>'responseDigest' THEN RETURN atrium.mfa_error('challenge_used'); END IF;
 IF c.status='claimed' THEN UPDATE atrium.mfa_challenges SET status='rejected' WHERE id=c.id; PERFORM atrium.mfa_audit('challenge.rejected',c.id,security); END IF;
 RETURN '{}'::jsonb;
END $$;

CREATE FUNCTION atrium.mfa_finish_ceremony(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; c atrium.mfa_challenges%ROWTYPE; f atrium.mfa_factors%ROWTYPE; a atrium.mfa_assurances%ROWTYPE; grant_row atrium.mfa_recovery_grants%ROWTYPE; result jsonb; factor_key uuid; was_pending boolean; counter_value bigint; victim atrium.user_sessions%ROWTYPE; new_expiry bigint;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['id','attemptId','responseDigest','kind','credential','newCounter','backedUp']::text[]) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid;

 IF NOT atrium.mfa_uuid(p_input->>'id') OR NOT atrium.mfa_uuid(p_input->>'attemptId') OR coalesce(p_input->>'responseDigest','')!~'^[0-9a-f]{64}$' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 SELECT * INTO c FROM atrium.mfa_challenges WHERE id=(p_input->>'id')::uuid AND user_id=actor AND session_id=sid FOR UPDATE;
 IF NOT FOUND OR c.attempt_id IS DISTINCT FROM (p_input->>'attemptId')::uuid OR c.response_digest IS DISTINCT FROM p_input->>'responseDigest' THEN RETURN atrium.mfa_error('challenge_used'); END IF;
 IF c.status='complete' THEN
  IF (c.receipt->>'securityVersion')::bigint<>security THEN RETURN atrium.mfa_error('state_changed'); END IF;
  IF c.receipt->>'outcome'='factor_pending' THEN
   IF NOT EXISTS(SELECT 1 FROM atrium.mfa_factors WHERE id=(c.receipt->>'factorId')::uuid AND user_id=actor AND status='pending' AND pending_session_id=sid AND pending_expires_at_ms>atrium.mfa_now()) THEN RETURN atrium.mfa_error('state_changed'); END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM atrium.mfa_assurances prior_proof JOIN atrium.mfa_factors prior_factor ON prior_factor.id=prior_proof.factor_id AND prior_factor.status='active' WHERE prior_proof.id=(c.receipt#>>'{assurance,id}')::uuid AND prior_proof.user_id=actor AND prior_proof.session_id=sid AND prior_proof.security_version=security AND prior_proof.expires_at_ms>atrium.mfa_now()) THEN RETURN atrium.mfa_error('state_changed'); END IF;
  RETURN c.receipt;
 END IF;
 IF c.status<>'claimed' THEN RETURN atrium.mfa_error('challenge_used'); END IF;
 IF c.expires_at_ms<=atrium.mfa_now() THEN RETURN atrium.mfa_error('challenge_expired'); END IF;
 IF c.credential_version<>(ctx->>'credentialVersion')::bigint OR c.security_version<>security OR c.origin<>p_origin OR c.rp_id<>p_rp_id OR c.kind IS DISTINCT FROM p_input->>'kind' THEN RETURN atrium.mfa_error('state_changed'); END IF;
 IF NOT atrium.mfa_challenge_authority(c) THEN RETURN atrium.mfa_error('reauthentication_required'); END IF;
 IF c.kind='registration' THEN
  IF jsonb_typeof(p_input->'credential')<>'object' OR (coalesce(p_input#>>'{credential,id}','')!~'^[A-Za-z0-9_-]+$' OR length(p_input#>>'{credential,id}')>1364)
   OR (coalesce(p_input#>>'{credential,publicKey}','')!~'^[A-Za-z0-9_-]+$' OR length(p_input#>>'{credential,publicKey}')>22000) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
  -- Recheck after crypto under the user lock: concurrent recovery grants cannot
  -- each consume the temporary slot. Challenge authority above verifies the grant.
  IF (SELECT count(*) FROM atrium.mfa_factors WHERE user_id=actor AND status IN ('pending','active')) >= (CASE WHEN c.intent='recover_factor' THEN 11 ELSE 10 END)
   OR (c.intent='recover_factor' AND EXISTS(SELECT 1 FROM atrium.mfa_factors WHERE user_id=actor AND status='pending' AND pending_intent='recover_factor')) THEN RETURN atrium.mfa_error('factor_limit'); END IF;
  IF c.intent='bootstrap' AND EXISTS(SELECT 1 FROM atrium.mfa_factors WHERE user_id=actor AND status IN ('active','pending')) THEN RETURN atrium.mfa_error('state_changed'); END IF;
  IF EXISTS(SELECT 1 FROM atrium.mfa_factors WHERE rp_id=p_rp_id AND credential_id=p_input#>>'{credential,id}') THEN RETURN atrium.mfa_error('verification_failed'); END IF;
  factor_key:=gen_random_uuid();
  INSERT INTO atrium.mfa_factors(id,user_id,rp_id,credential_id,public_key,label,counter,status,backup_eligible,backed_up,transports,created_at_ms,pending_session_id,pending_intent,pending_expires_at_ms,pending_challenge_id,reauthentication_id,manage_proof_id,recovery_grant_id)
  VALUES(factor_key,actor,p_rp_id,p_input#>>'{credential,id}',p_input#>>'{credential,publicKey}',c.label,(p_input#>>'{credential,counter}')::bigint,'pending',
   (p_input#>>'{credential,backupEligible}')::boolean,(p_input#>>'{credential,backedUp}')::boolean,ARRAY(SELECT jsonb_array_elements_text(p_input#>'{credential,transports}')),stamp,sid,c.intent,c.expires_at_ms,c.id,c.reauthentication_id,c.manage_proof_id,c.recovery_grant_id);
  IF c.intent='recover_factor' THEN
   UPDATE atrium.mfa_recovery_grants SET consumed_by=c.id WHERE id=c.recovery_grant_id AND consumed_by IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'Recovery claim changed' USING ERRCODE='40001'; END IF;
  END IF;
  PERFORM atrium.mfa_audit('factor.pending',factor_key,security);
  result:=jsonb_build_object('challengeId',c.id,'securityVersion',security,'factorId',factor_key,'outcome','factor_pending','assurance',NULL);
 ELSE
  SELECT * INTO f FROM atrium.mfa_factors WHERE id=c.claimed_factor_id AND user_id=actor FOR UPDATE;
  IF NOT FOUND OR f.counter IS DISTINCT FROM c.claimed_counter OR f.counter_revision IS DISTINCT FROM c.claimed_counter_revision
   OR (f.status<>'active' AND NOT(f.status='pending' AND f.pending_session_id=sid AND f.pending_expires_at_ms>atrium.mfa_now() AND c.intent<>'verify')) THEN RETURN atrium.mfa_error('state_changed'); END IF;
  counter_value:=(p_input->>'newCounter')::bigint;
  IF counter_value IS NULL OR counter_value NOT BETWEEN 0 AND 4294967295 OR ((counter_value>0 OR f.counter>0) AND counter_value<=f.counter)
   OR (p_input->>'backedUp') IS NULL OR ((p_input->>'backedUp')::boolean AND NOT f.backup_eligible) THEN RETURN atrium.mfa_error('verification_failed'); END IF;
  was_pending:=f.status='pending'; factor_key:=f.id;
  IF was_pending THEN
   IF security>=9007199254740991 THEN RETURN atrium.mfa_error('mfa_unavailable'); END IF;
   security:=security+1;
   UPDATE atrium.mfa_states SET security_version=security,ever_enabled=true WHERE user_id=actor;
   IF f.pending_intent='recover_factor' THEN
    UPDATE atrium.mfa_factors SET status='revoked',revoked_at_ms=greatest(stamp,created_at_ms) WHERE user_id=actor AND id<>f.id AND status IN ('active','pending');
    UPDATE atrium.mfa_recovery_codes SET revoked_at_ms=stamp WHERE user_id=actor AND revoked_at_ms IS NULL;
    FOR victim IN SELECT * FROM atrium.user_sessions WHERE user_id=actor AND id<>sid AND revoked_at_ms IS NULL ORDER BY id FOR UPDATE LOOP
     UPDATE atrium.user_sessions SET revoked_at_ms=greatest(stamp,created_at_ms) WHERE id=victim.id;
     INSERT INTO atrium.user_session_events(session_id,user_id,operation,reason,at_ms,actor_session_id) VALUES(victim.id,actor,'revoked','revoke_others',greatest(stamp,victim.created_at_ms),sid);
    END LOOP;
    PERFORM atrium.mfa_audit('recovery.replaced',factor_key,security);
   END IF;
   PERFORM atrium.mfa_audit('factor.activated',factor_key,security);
  END IF;
  UPDATE atrium.mfa_factors SET status='active',counter=counter_value,counter_revision=counter_revision+1,backed_up=(p_input->>'backedUp')::boolean,last_used_at_ms=greatest(stamp,created_at_ms) WHERE id=f.id;
  -- Every signed assertion establishes this login; step-up has a separate shorter receipt.
  INSERT INTO atrium.mfa_assurances(id,user_id,session_id,credential_version,security_version,factor_id,purpose,verified_at_ms,expires_at_ms)
   VALUES(gen_random_uuid(),actor,sid,(ctx->>'credentialVersion')::bigint,security,f.id,'session_login',stamp,(ctx->>'sessionExpiresAt')::bigint) RETURNING * INTO a;
  IF NOT was_pending AND c.purpose<>'session_login' THEN
   INSERT INTO atrium.mfa_assurances(id,user_id,session_id,credential_version,security_version,factor_id,purpose,verified_at_ms,expires_at_ms)
    VALUES(gen_random_uuid(),actor,sid,(ctx->>'credentialVersion')::bigint,security,f.id,c.purpose,stamp,least(stamp+600000,(ctx->>'sessionExpiresAt')::bigint)) RETURNING * INTO a;
  END IF;
  PERFORM atrium.mfa_audit('assurance.verified',a.id,security);
  result:=jsonb_build_object('challengeId',c.id,'securityVersion',security,'factorId',f.id,'outcome','verified','assurance',atrium.mfa_assurance_json(a));
 END IF;
 UPDATE atrium.mfa_challenges SET status='complete',receipt=result WHERE id=c.id;
 RETURN result;
END $$;

CREATE FUNCTION atrium.mfa_current_proof(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; purpose text;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['purpose']::text[]) THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid;

 purpose:=p_input->>'purpose'; IF purpose IS NULL OR purpose NOT IN ('session_login','organization_administration','manage_factors') THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 RETURN coalesce(atrium.mfa_proof(purpose),'null'::jsonb);
END $$;

CREATE FUNCTION atrium.mfa_request_result(p_operation text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r atrium.mfa_requests%ROWTYPE;
BEGIN
 SELECT * INTO r FROM atrium.mfa_requests WHERE id=(p_input->>'requestId')::uuid AND user_id=atrium.context('actor_user_id');
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF r.session_id::text<>atrium.context('session_id') OR r.operation<>p_operation OR r.manifest<>p_input THEN RETURN atrium.mfa_error('state_changed'); END IF;
 RETURN r.result;
END $$;
CREATE FUNCTION atrium.mfa_save_request(p_operation text,p_input jsonb,p_result jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO atrium.mfa_requests(id,user_id,session_id,operation,manifest,result,at_ms)
 VALUES((p_input->>'requestId')::uuid,atrium.context('actor_user_id'),atrium.context('session_id')::uuid,p_operation,p_input,p_result,atrium.mfa_now());
 RETURN p_result;
END $$;

CREATE FUNCTION atrium.mfa_revoke_factor(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; result jsonb; request uuid; reauth uuid; f atrium.mfa_factors%ROWTYPE;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['requestId','expectedSecurityVersion','reauthenticationId','factorId']::text[]) OR NOT atrium.mfa_uuid(p_input->>'requestId') OR NOT atrium.mfa_uuid(p_input->>'reauthenticationId') THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid; request:=(p_input->>'requestId')::uuid; reauth:=(p_input->>'reauthenticationId')::uuid;

 IF NOT atrium.mfa_uuid(p_input->>'factorId') THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 result:=atrium.mfa_request_result('factor.revoke',p_input); IF result IS NOT NULL THEN RETURN result; END IF;
 IF (p_input->>'expectedSecurityVersion')::bigint IS DISTINCT FROM security THEN RETURN atrium.mfa_error('state_changed'); END IF;
 IF NOT atrium.mfa_reauth(reauth,security) THEN RETURN atrium.mfa_error('reauthentication_required'); END IF;
 IF atrium.mfa_proof('manage_factors') IS NULL THEN RETURN atrium.mfa_error('mfa_required'); END IF;
 SELECT * INTO f FROM atrium.mfa_factors WHERE id=(p_input->>'factorId')::uuid AND user_id=actor AND status IN ('active','pending') FOR UPDATE;
 IF NOT FOUND THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 IF f.status='active' AND (SELECT count(*) FROM atrium.mfa_factors WHERE user_id=actor AND status='active')<=1 THEN RETURN atrium.mfa_error('last_factor'); END IF;
 IF security>=9007199254740991 THEN RETURN atrium.mfa_error('mfa_unavailable'); END IF;
 UPDATE atrium.mfa_password_checks SET consumed_by=request WHERE id=reauth;
 UPDATE atrium.mfa_factors SET status='revoked',revoked_at_ms=greatest(stamp,created_at_ms) WHERE id=f.id;
 security:=security+1; UPDATE atrium.mfa_states SET security_version=security WHERE user_id=actor;
 PERFORM atrium.mfa_audit('factor.revoked',f.id,security);
 RETURN atrium.mfa_save_request('factor.revoke',p_input,jsonb_build_object('securityVersion',security));
END $$;

CREATE FUNCTION atrium.mfa_rotate_recovery(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; result jsonb; request uuid; reauth uuid; code jsonb;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['requestId','expectedSecurityVersion','reauthenticationId','codes']::text[]) OR NOT atrium.mfa_uuid(p_input->>'requestId') OR NOT atrium.mfa_uuid(p_input->>'reauthenticationId') THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid; request:=(p_input->>'requestId')::uuid; reauth:=(p_input->>'reauthenticationId')::uuid;

 IF jsonb_typeof(p_input->'codes')<>'array' OR jsonb_array_length(p_input->'codes')<>10 THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'codes') c WHERE NOT atrium.mfa_keys(c,ARRAY['id','hash']) OR NOT atrium.mfa_uuid(c->>'id') OR coalesce(c->>'hash','')!~'^[0-9a-f]{64}$')
 OR (SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(p_input->'codes') c)<>10 OR (SELECT count(DISTINCT c->>'hash') FROM jsonb_array_elements(p_input->'codes') c)<>10 THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 result:=atrium.mfa_request_result('recovery.rotate',p_input); IF result IS NOT NULL THEN RETURN result; END IF;
 IF (p_input->>'expectedSecurityVersion')::bigint IS DISTINCT FROM security THEN RETURN atrium.mfa_error('state_changed'); END IF;
 IF NOT atrium.mfa_reauth(reauth,security) THEN RETURN atrium.mfa_error('reauthentication_required'); END IF;
 IF atrium.mfa_proof('manage_factors') IS NULL THEN RETURN atrium.mfa_error('mfa_required'); END IF;
 UPDATE atrium.mfa_password_checks SET consumed_by=request WHERE id=reauth;
 UPDATE atrium.mfa_recovery_codes SET revoked_at_ms=stamp WHERE user_id=actor AND revoked_at_ms IS NULL;
 FOR code IN SELECT value FROM jsonb_array_elements(p_input->'codes') LOOP
  INSERT INTO atrium.mfa_recovery_codes(id,user_id,generation_id,code_hash,created_at_ms) VALUES((code->>'id')::uuid,actor,request,code->>'hash',stamp);
 END LOOP;
 PERFORM atrium.mfa_audit('recovery.rotated',request,security);
 RETURN atrium.mfa_save_request('recovery.rotate',p_input,jsonb_build_object('requestId',request,'securityVersion',security,'count',10));
END $$;

CREATE FUNCTION atrium.mfa_redeem_recovery(p_input jsonb,p_origin text,p_rp_id text,p_handle text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; stamp bigint; security bigint; actor text; sid uuid; result jsonb; request uuid; reauth uuid; charged jsonb; code atrium.mfa_recovery_codes%ROWTYPE; expiry bigint;
BEGIN
 IF NOT atrium.mfa_keys(p_input,ARRAY['requestId','expectedSecurityVersion','reauthenticationId','codeHash']::text[]) OR NOT atrium.mfa_uuid(p_input->>'requestId') OR NOT atrium.mfa_uuid(p_input->>'reauthenticationId') THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 ctx:=atrium.mfa_lock_context(p_origin,p_rp_id,p_handle); IF ctx?'error' THEN RETURN ctx; END IF;
 stamp:=(ctx->>'now')::bigint; security:=(ctx->>'securityVersion')::bigint; actor:=ctx->>'userId'; sid:=(ctx->>'sessionId')::uuid; request:=(p_input->>'requestId')::uuid; reauth:=(p_input->>'reauthenticationId')::uuid;

 IF coalesce(p_input->>'codeHash','')!~'^[0-9a-f]{64}$' THEN RETURN atrium.mfa_error('invalid_input'); END IF;
 result:=atrium.mfa_request_result('recovery.redeem',p_input); IF result IS NOT NULL THEN RETURN result; END IF;
 IF (p_input->>'expectedSecurityVersion')::bigint IS DISTINCT FROM security THEN RETURN atrium.mfa_error('state_changed'); END IF;
 IF NOT atrium.mfa_reauth(reauth,security) THEN RETURN atrium.mfa_error('reauthentication_required'); END IF;
 charged:=atrium.mfa_charge('recovery',request,10); IF charged IS NOT NULL THEN RETURN charged; END IF;
 UPDATE atrium.mfa_password_checks SET consumed_by=request WHERE id=reauth;
 SELECT * INTO code FROM atrium.mfa_recovery_codes WHERE user_id=actor AND code_hash=p_input->>'codeHash' AND consumed_by IS NULL AND revoked_at_ms IS NULL FOR UPDATE;
 IF NOT FOUND OR NOT (ctx->>'everEnabled')::boolean THEN RETURN atrium.mfa_save_request('recovery.redeem',p_input,atrium.mfa_error('recovery_failed')); END IF;
 UPDATE atrium.mfa_recovery_codes SET consumed_by=request WHERE id=code.id;
 expiry:=least(stamp+300000,(ctx->>'sessionExpiresAt')::bigint,(SELECT expires_at_ms FROM atrium.mfa_password_checks WHERE id=reauth));
 INSERT INTO atrium.mfa_recovery_grants(id,user_id,session_id,credential_version,security_version,created_at_ms,expires_at_ms,reauthentication_id)
 VALUES(request,actor,sid,(ctx->>'credentialVersion')::bigint,security,stamp,expiry,reauth);
 PERFORM atrium.mfa_audit('recovery.redeemed',request,security);
 RETURN atrium.mfa_save_request('recovery.redeem',p_input,jsonb_build_object('id',request,'securityVersion',security,'expiresAt',expiry));
END $$;

-- Acyclic leaf: this finite owner reads only direct-self rows, not the dependent
-- staff/users/membership policies. No browser flag can satisfy login assurance.
CREATE FUNCTION atrium.mfa_login_allowed() RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF atrium.context('session_id') IS NULL THEN RETURN true; END IF;
 IF atrium.context('actor_user_id') IS NULL OR atrium.context('credential_version') IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM atrium.user_sessions WHERE id::text=atrium.context('session_id') AND user_id=atrium.context('actor_user_id') AND credential_version::text=atrium.context('credential_version') AND revoked_at_ms IS NULL AND expires_at_ms>atrium.mfa_now()) THEN RETURN false; END IF;
 -- Credential-current checks belong to the caller's user policy/admission. This
 -- leaf remains true across the account command's one-version trigger transition.
 RETURN NOT atrium.mfa_required() OR EXISTS(SELECT 1 FROM atrium.mfa_assurances a
 JOIN atrium.mfa_states m ON m.user_id=a.user_id AND m.security_version=a.security_version
 JOIN atrium.mfa_factors f ON f.id=a.factor_id AND f.user_id=a.user_id AND f.status='active'
 WHERE a.user_id=atrium.context('actor_user_id') AND a.session_id::text=atrium.context('session_id')
 AND a.credential_version::text=atrium.context('credential_version') AND a.purpose='session_login' AND a.expires_at_ms>atrium.mfa_now());
END $$;
CREATE OR REPLACE FUNCTION atrium.staff_context() RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT atrium.context('actor_user_id') IS NOT NULL AND atrium.context('credential_version') IS NOT NULL AND atrium.context('channel_binding_id') IS NULL
 AND atrium.session_context_valid() AND atrium.mfa_login_allowed()
$$;
CREATE FUNCTION atrium.mfa_hold_proof(p_id uuid,p_purpose text) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u atrium.users%ROWTYPE; s atrium.user_sessions%ROWTYPE; m atrium.mfa_states%ROWTYPE; a atrium.mfa_assurances%ROWTYPE;
BEGIN
 IF session_user<>'atrium_app' OR NOT atrium.mfa_uuid(atrium.context('session_id')) OR p_purpose NOT IN ('organization_administration','manage_factors')
 OR atrium.context('channel_binding_id') IS NOT NULL OR atrium.context('channel_binding_version') IS NOT NULL
 OR atrium.context('channel_provider') IS NOT NULL OR atrium.context('channel_external_id') IS NOT NULL
 OR atrium.context('login_username') IS NOT NULL THEN RETURN false; END IF;
 SELECT * INTO u FROM atrium.users WHERE id=atrium.context('actor_user_id') FOR SHARE;
 IF NOT FOUND OR u.status<>'active' OR u.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN false; END IF;
 SELECT * INTO s FROM atrium.user_sessions WHERE id=atrium.context('session_id')::uuid AND user_id=u.id FOR SHARE;
 IF NOT FOUND OR s.revoked_at_ms IS NOT NULL OR s.credential_version<>u.credential_version OR s.expires_at_ms<=atrium.mfa_now() THEN RETURN false; END IF;
 SELECT * INTO m FROM atrium.mfa_states WHERE user_id=u.id FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO a FROM atrium.mfa_assurances WHERE id=p_id AND user_id=u.id AND session_id=s.id AND credential_version=u.credential_version AND security_version=m.security_version AND purpose=p_purpose;
 IF NOT FOUND OR a.expires_at_ms<=atrium.mfa_now() THEN RETURN false; END IF;
 PERFORM 1 FROM atrium.mfa_factors WHERE id=a.factor_id AND user_id=u.id AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM atrium.mfa_assurances WHERE id=a.id AND expires_at_ms>atrium.mfa_now() FOR SHARE;
 RETURN FOUND AND atrium.mfa_login_allowed();
END $$;
CREATE FUNCTION atrium.mfa_immutable_event() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'MFA audit and receipts are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER mfa_event_immutable BEFORE UPDATE OR DELETE ON atrium.mfa_events FOR EACH ROW EXECUTE FUNCTION atrium.mfa_immutable_event();
CREATE TRIGGER mfa_request_immutable BEFORE UPDATE OR DELETE ON atrium.mfa_requests FOR EACH ROW EXECUTE FUNCTION atrium.mfa_immutable_event();
CREATE TRIGGER mfa_assurance_immutable BEFORE UPDATE OR DELETE ON atrium.mfa_assurances FOR EACH ROW EXECUTE FUNCTION atrium.mfa_immutable_event();
CREATE FUNCTION atrium.mfa_preserve_factor() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MFA factor history is immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.user_id,NEW.rp_id,NEW.credential_id,NEW.public_key,NEW.backup_eligible,NEW.created_at_ms,NEW.pending_session_id,NEW.pending_intent,NEW.pending_expires_at_ms,NEW.pending_challenge_id,NEW.reauthentication_id,NEW.manage_proof_id,NEW.recovery_grant_id)
 IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.rp_id,OLD.credential_id,OLD.public_key,OLD.backup_eligible,OLD.created_at_ms,OLD.pending_session_id,OLD.pending_intent,OLD.pending_expires_at_ms,OLD.pending_challenge_id,OLD.reauthentication_id,OLD.manage_proof_id,OLD.recovery_grant_id)
 OR NEW.counter<OLD.counter OR NEW.counter_revision<OLD.counter_revision OR (OLD.status IN ('revoked','expired') AND NEW IS DISTINCT FROM OLD)
 OR (OLD.status='active' AND NEW.status='pending') THEN RAISE EXCEPTION 'MFA factor ownership and counter history are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mfa_factor_history BEFORE UPDATE OR DELETE ON atrium.mfa_factors FOR EACH ROW EXECUTE FUNCTION atrium.mfa_preserve_factor();
CREATE FUNCTION atrium.mfa_preserve_state() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MFA enrollment history cannot reset' USING ERRCODE='23514'; END IF;
 IF (NEW.user_id,NEW.origin,NEW.rp_id,NEW.user_handle) IS DISTINCT FROM (OLD.user_id,OLD.origin,OLD.rp_id,OLD.user_handle)
 OR NEW.security_version<OLD.security_version OR (OLD.ever_enabled AND NOT NEW.ever_enabled) THEN RAISE EXCEPTION 'MFA enrollment history cannot reset' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mfa_state_history BEFORE UPDATE OR DELETE ON atrium.mfa_states FOR EACH ROW EXECUTE FUNCTION atrium.mfa_preserve_state();

CREATE OR REPLACE FUNCTION atrium.hold_current_session() RETURNS boolean
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
  RETURN FOUND AND selected.revoked_at_ms IS NULL AND selected.expires_at_ms>stamp AND atrium.mfa_login_allowed();
END $$;


GRANT USAGE,CREATE ON SCHEMA atrium TO atrium_mfa_executor;
GRANT USAGE ON TYPE atrium.record_id,atrium.positive_version TO atrium_mfa_executor;
GRANT SELECT ON atrium.users,atrium.memberships,atrium.user_credentials,atrium.user_sessions TO atrium_mfa_executor;
GRANT UPDATE(id) ON atrium.users TO atrium_mfa_executor;
GRANT UPDATE(revoked_at_ms) ON atrium.user_sessions TO atrium_mfa_executor;
GRANT INSERT ON atrium.user_session_events TO atrium_mfa_executor;
GRANT SELECT,INSERT,UPDATE ON atrium.mfa_states,atrium.mfa_password_checks,atrium.mfa_factors,atrium.mfa_recovery_codes,atrium.mfa_recovery_grants TO atrium_mfa_executor;
GRANT SELECT,INSERT,UPDATE,DELETE ON atrium.mfa_challenges TO atrium_mfa_executor;
GRANT SELECT,INSERT,DELETE ON atrium.mfa_attempts TO atrium_mfa_executor;
GRANT SELECT,INSERT ON atrium.mfa_assurances,atrium.mfa_requests TO atrium_mfa_executor;
GRANT INSERT ON atrium.mfa_events TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.context(text) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_now() TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_error(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_error(text,integer) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_uuid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_uuid(text) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_factor_json(atrium.mfa_factors) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_factor_json(atrium.mfa_factors) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_assurance_json(atrium.mfa_assurances) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_assurance_json(atrium.mfa_assurances) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_required() TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_proof(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_proof(text) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_lock_context(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_lock_context(text,text,text) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_charge(text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_charge(text,uuid,integer) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_audit(text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_audit(text,uuid,bigint) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_reauth(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_reauth(uuid,bigint,uuid) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_challenge_authority(atrium.mfa_challenges) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_challenge_authority(atrium.mfa_challenges) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_keys(jsonb,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_keys(jsonb,text[]) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_read_state(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_read_state(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_read_state(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_reserve_password(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_reserve_password(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_reserve_password(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_complete_password(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_complete_password(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_complete_password(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_begin_ceremony(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_begin_ceremony(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_begin_ceremony(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_claim_ceremony(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_claim_ceremony(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_claim_ceremony(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_reject_ceremony(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_reject_ceremony(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_reject_ceremony(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_finish_ceremony(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_finish_ceremony(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_finish_ceremony(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_current_proof(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_current_proof(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_current_proof(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_request_result(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_request_result(text,jsonb) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_save_request(text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_save_request(text,jsonb,jsonb) TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_revoke_factor(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_revoke_factor(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_revoke_factor(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_rotate_recovery(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_rotate_recovery(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_rotate_recovery(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_redeem_recovery(jsonb,text,text,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_redeem_recovery(jsonb,text,text,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_redeem_recovery(jsonb,text,text,text) TO atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.mfa_login_allowed() FROM PUBLIC;
ALTER FUNCTION atrium.mfa_login_allowed() OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_login_allowed() TO atrium_app,atrium_authenticator,atrium_account_executor,atrium_session_executor;
REVOKE ALL ON FUNCTION atrium.mfa_hold_proof(uuid,text) FROM PUBLIC;
ALTER FUNCTION atrium.mfa_hold_proof(uuid,text) OWNER TO atrium_mfa_executor;
GRANT EXECUTE ON FUNCTION atrium.mfa_hold_proof(uuid,text) TO atrium_app;
REVOKE ALL ON FUNCTION atrium.mfa_immutable_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_immutable_event() TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_preserve_factor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_preserve_factor() TO atrium_mfa_executor;
REVOKE ALL ON FUNCTION atrium.mfa_preserve_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_preserve_state() TO atrium_mfa_executor;
REVOKE CREATE ON SCHEMA atrium FROM atrium_mfa_executor;
RESET ROLE;

SET LOCAL ROLE atrium_admin;
-- Bindings are immutable even to a mistakenly broadened maintenance command.
CREATE FUNCTION atrium.mfa_preserve_ceremony() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MFA ceremony history is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','attempt_id','response_digest','claimed_factor_id','claimed_counter','claimed_counter_revision','receipt'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','attempt_id','response_digest','claimed_factor_id','claimed_counter','claimed_counter_revision','receipt'])
 OR (OLD.status IN ('rejected','complete') AND NEW IS DISTINCT FROM OLD)
 OR (OLD.status='claimed' AND NEW.status='ready')
 OR (OLD.attempt_id IS NOT NULL AND (NEW.attempt_id,NEW.response_digest) IS DISTINCT FROM (OLD.attempt_id,OLD.response_digest))
 OR (OLD.claimed_factor_id IS NOT NULL AND (NEW.claimed_factor_id,NEW.claimed_counter,NEW.claimed_counter_revision) IS DISTINCT FROM (OLD.claimed_factor_id,OLD.claimed_counter,OLD.claimed_counter_revision))
 THEN RAISE EXCEPTION 'MFA ceremony binding and consumption are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mfa_ceremony_history BEFORE UPDATE OR DELETE ON atrium.mfa_challenges FOR EACH ROW EXECUTE FUNCTION atrium.mfa_preserve_ceremony();
CREATE FUNCTION atrium.mfa_preserve_consumable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MFA authorization history is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['consumed_by','verified_at_ms','revoked_at_ms']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_by','verified_at_ms','revoked_at_ms'])
 OR (OLD.consumed_by IS NOT NULL AND NEW.consumed_by IS DISTINCT FROM OLD.consumed_by)
 OR (to_jsonb(OLD)->>'verified_at_ms' IS NOT NULL AND (to_jsonb(NEW)->>'verified_at_ms') IS DISTINCT FROM (to_jsonb(OLD)->>'verified_at_ms'))
 OR (to_jsonb(OLD)->>'revoked_at_ms' IS NOT NULL AND (to_jsonb(NEW)->>'revoked_at_ms') IS DISTINCT FROM (to_jsonb(OLD)->>'revoked_at_ms'))
 THEN RAISE EXCEPTION 'MFA authorization binding and consumption are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mfa_password_history BEFORE UPDATE OR DELETE ON atrium.mfa_password_checks FOR EACH ROW EXECUTE FUNCTION atrium.mfa_preserve_consumable();
CREATE TRIGGER mfa_grant_history BEFORE UPDATE OR DELETE ON atrium.mfa_recovery_grants FOR EACH ROW EXECUTE FUNCTION atrium.mfa_preserve_consumable();
CREATE TRIGGER mfa_code_history BEFORE UPDATE OR DELETE ON atrium.mfa_recovery_codes FOR EACH ROW EXECUTE FUNCTION atrium.mfa_preserve_consumable();
REVOKE ALL ON FUNCTION atrium.mfa_preserve_ceremony(),atrium.mfa_preserve_consumable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.mfa_preserve_ceremony(),atrium.mfa_preserve_consumable() TO atrium_mfa_executor;
GRANT UPDATE(id) ON atrium.mfa_assurances TO atrium_mfa_executor;

RESET ROLE;
