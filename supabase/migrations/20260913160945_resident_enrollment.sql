-- First-party, property-approved recipient enrollment. No provider delivery or consent.
SET LOCAL ROLE atrium_admin;
CREATE TABLE atrium.resident_enrollment_policies (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, version atrium.positive_version NOT NULL,
 enabled boolean NOT NULL, method text NOT NULL CHECK(method='in_person_staff_check'), protocol text NOT NULL CHECK(length(protocol) BETWEEN 20 AND 2000),
 invitation_lifetime_minutes integer NOT NULL CHECK(invitation_lifetime_minutes BETWEEN 15 AND 1440), source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 3 AND 240),
 observed_at timestamptz(3) NOT NULL, valid_until timestamptz(3) NOT NULL, published_by atrium.record_id NOT NULL REFERENCES atrium.users(id),
 published_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,property_id,version),
 FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id),
 CHECK(valid_until>observed_at AND valid_until-observed_at<=interval '90 days')
);
CREATE TABLE atrium.resident_enrollment_invites (
 id uuid PRIMARY KEY, organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, resident_id uuid NOT NULL,
 resident_version atrium.positive_version NOT NULL, source_id uuid NOT NULL, policy_version atrium.positive_version NOT NULL,
 configuration_version atrium.positive_version NOT NULL, version atrium.positive_version NOT NULL DEFAULT 1,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 checked_at timestamptz(3) NOT NULL, checked_by atrium.record_id NOT NULL REFERENCES atrium.users(id),
 evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 3 AND 240), actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id),
 actor_credential_version atrium.positive_version NOT NULL, proof_id uuid NOT NULL REFERENCES atrium.mfa_assurances(id),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz(3) NOT NULL, revoked_at timestamptz(3), consumed_at timestamptz(3),
 UNIQUE(organization_id,property_id,id), FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id,source_id) REFERENCES atrium.resident_sources(organization_id,property_id,resident_id,id),
 FOREIGN KEY(organization_id,property_id,policy_version) REFERENCES atrium.resident_enrollment_policies(organization_id,property_id,version),
 FOREIGN KEY(organization_id,property_id,configuration_version) REFERENCES atrium.property_configurations(organization_id,property_id,version),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours' AND expires_at<=checked_at+interval '24 hours'),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at), CHECK(consumed_at IS NULL OR consumed_at>=created_at), CHECK(revoked_at IS NULL OR consumed_at IS NULL)
);
CREATE UNIQUE INDEX enrollment_pending_resident ON atrium.resident_enrollment_invites(organization_id,property_id,resident_id) WHERE revoked_at IS NULL AND consumed_at IS NULL;
CREATE TABLE atrium.resident_account_bindings (
 id uuid PRIMARY KEY, organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, resident_id uuid NOT NULL,
 resident_version atrium.positive_version NOT NULL, source_id uuid NOT NULL, policy_version atrium.positive_version NOT NULL,
 configuration_version atrium.positive_version NOT NULL, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), invitation_id uuid NOT NULL UNIQUE,
 unit_id atrium.record_id NOT NULL, version atrium.positive_version NOT NULL DEFAULT 1,
 activated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz(3),
 UNIQUE(organization_id,property_id,id), FOREIGN KEY(organization_id,property_id,invitation_id) REFERENCES atrium.resident_enrollment_invites(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id,source_id) REFERENCES atrium.resident_sources(organization_id,property_id,resident_id,id),
 FOREIGN KEY(organization_id,property_id,policy_version) REFERENCES atrium.resident_enrollment_policies(organization_id,property_id,version),
 CHECK(revoked_at IS NULL OR revoked_at>=activated_at)
);
CREATE UNIQUE INDEX enrollment_active_resident ON atrium.resident_account_bindings(organization_id,property_id,resident_id) WHERE revoked_at IS NULL;
CREATE INDEX enrollment_own_bindings ON atrium.resident_account_bindings(user_id,id);
CREATE TABLE atrium.resident_enrollment_attempts (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE, token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 browser_hash text NOT NULL CHECK(browser_hash ~ '^[a-f0-9]{64}$'), mode text NOT NULL CHECK(mode IN ('new','existing')),
 invitation_id uuid NOT NULL REFERENCES atrium.resident_enrollment_invites(id), invitation_version atrium.positive_version NOT NULL,
 user_id atrium.record_id NOT NULL, username text NOT NULL CHECK(username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'), display_name text NOT NULL CHECK(length(btrim(display_name)) BETWEEN 1 AND 200),
 credential_version atrium.positive_version NOT NULL, session_id uuid REFERENCES atrium.user_sessions(id),
 credential_commitment text CHECK(credential_commitment ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz(3) NOT NULL, completed_at timestamptz(3), receipt jsonb,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 CHECK((mode='new' AND session_id IS NULL) OR (mode='existing' AND session_id IS NOT NULL AND credential_commitment IS NOT NULL)),
 CHECK((completed_at IS NULL AND receipt IS NULL) OR (completed_at>=created_at AND jsonb_typeof(receipt)='object'))
);
CREATE INDEX enrollment_attempt_expiry ON atrium.resident_enrollment_attempts(expires_at) WHERE completed_at IS NULL;
CREATE TABLE atrium.resident_enrollment_commands (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id),
 actor_credential_version atrium.positive_version NOT NULL, request_id uuid NOT NULL,
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND pg_column_size(manifest)<=16384), receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 PRIMARY KEY(organization_id,property_id,actor_user_id,request_id), FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id)
);
CREATE TABLE atrium.resident_enrollment_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL,
 resident_id uuid, operation text NOT NULL CHECK(operation IN ('policy.published','invitation.issued','invitation.revoked','binding.revoked','binding.activated')),
 resource_id text NOT NULL, resource_version atrium.positive_version NOT NULL, request_id uuid NOT NULL,
 actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_session_id uuid REFERENCES atrium.user_sessions(id),
 actor_credential_version atrium.positive_version NOT NULL, proof_id uuid REFERENCES atrium.mfa_assurances(id), reason text CHECK(length(reason) BETWEEN 3 AND 1000),
 at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id)
);
CREATE TABLE atrium.resident_enrollment_budgets (
 kind text NOT NULL CHECK(kind IN ('client','token')), key text NOT NULL CHECK(key ~ '^[a-f0-9]{64}$'),
 attempts timestamptz[] NOT NULL DEFAULT '{}', last_reserved_at timestamptz NOT NULL,
 PRIMARY KEY(kind,key), CHECK(cardinality(attempts)<=30 AND array_position(attempts,NULL) IS NULL)
);
CREATE INDEX enrollment_budget_expiry ON atrium.resident_enrollment_budgets(last_reserved_at);

-- Private selectors are set only LOCAL by finite commands. Runtime roles receive no
-- raw table privileges, and supplying these GUCs never constitutes admission.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['resident_enrollment_policies','resident_enrollment_invites','resident_account_bindings','resident_enrollment_attempts','resident_enrollment_commands','resident_enrollment_events','resident_enrollment_budgets'] LOOP
  EXECUTE format('ALTER TABLE atrium.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE atrium.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON atrium.%I FROM PUBLIC,atrium_app,atrium_authenticator',t);
  EXECUTE format('CREATE POLICY maintenance ON atrium.%I TO atrium_admin USING(true) WITH CHECK(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['resident_enrollment_policies','resident_enrollment_commands','resident_enrollment_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON atrium.%I FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['resident_enrollment_policies','resident_enrollment_commands','resident_enrollment_events'] LOOP
  EXECUTE format('CREATE POLICY enrollment_scope ON atrium.%I TO atrium_enrollment_executor USING(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id'')) WITH CHECK(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id''))',t);
 END LOOP;
END $$;
CREATE POLICY enrollment_invite ON atrium.resident_enrollment_invites TO atrium_enrollment_executor
 USING((organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id')) OR token_hash=atrium.context('enrollment_token_hash'))
 WITH CHECK(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id'));
CREATE POLICY enrollment_binding ON atrium.resident_account_bindings TO atrium_enrollment_executor
 USING((organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id')) OR user_id=atrium.context('actor_user_id'))
 WITH CHECK(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id'));
CREATE POLICY enrollment_attempt ON atrium.resident_enrollment_attempts TO atrium_enrollment_executor
 USING(token_hash=atrium.context('enrollment_token_hash') OR (user_id=atrium.context('actor_user_id') AND completed_at IS NOT NULL))
 WITH CHECK(token_hash=atrium.context('enrollment_token_hash'));
CREATE POLICY enrollment_budget ON atrium.resident_enrollment_budgets TO atrium_enrollment_executor USING(true) WITH CHECK(true);
CREATE POLICY enrollment_identity ON atrium.users FOR SELECT TO atrium_enrollment_executor
 USING(id=atrium.context('actor_user_id') OR id=atrium.context('enrollment_new_user_id') OR EXISTS(
 SELECT 1 FROM atrium.memberships m WHERE m.user_id=users.id AND m.organization_id=atrium.context('organization_id')));
CREATE POLICY enrollment_identity_lock ON atrium.users FOR UPDATE TO atrium_enrollment_executor USING(
 id=atrium.context('actor_user_id') OR id=atrium.context('enrollment_new_user_id') OR EXISTS(SELECT 1 FROM atrium.memberships m WHERE m.user_id=users.id AND m.organization_id=atrium.context('organization_id'))) WITH CHECK(false);
CREATE POLICY enrollment_new_identity ON atrium.users FOR INSERT TO atrium_enrollment_executor WITH CHECK(
 id=atrium.context('enrollment_new_user_id') AND credential_version=1 AND status='active');
CREATE POLICY enrollment_credential ON atrium.user_credentials FOR SELECT TO atrium_enrollment_executor
 USING(user_id=atrium.context('actor_user_id') OR user_id=atrium.context('enrollment_new_user_id'));
CREATE POLICY enrollment_new_credential ON atrium.user_credentials FOR INSERT TO atrium_enrollment_executor WITH CHECK(user_id=atrium.context('enrollment_new_user_id'));
CREATE POLICY enrollment_session ON atrium.user_sessions FOR SELECT TO atrium_enrollment_executor USING(
 id::text=atrium.context('session_id') AND user_id=atrium.context('actor_user_id') AND credential_version::text=atrium.context('credential_version')
 AND audience=coalesce(atrium.context('session_audience'),'staff'));
CREATE POLICY enrollment_session_lock ON atrium.user_sessions FOR UPDATE TO atrium_enrollment_executor USING(
 id::text=atrium.context('session_id') AND user_id=atrium.context('actor_user_id')) WITH CHECK(false);
CREATE POLICY enrollment_membership ON atrium.memberships FOR SELECT TO atrium_enrollment_executor USING(organization_id=atrium.context('organization_id'));
CREATE POLICY enrollment_grant ON atrium.property_grants FOR SELECT TO atrium_enrollment_executor USING(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id'));
CREATE POLICY enrollment_organization ON atrium.organizations FOR SELECT TO atrium_enrollment_executor USING(id=atrium.context('organization_id'));
CREATE POLICY enrollment_property ON atrium.properties FOR SELECT TO atrium_enrollment_executor USING(organization_id=atrium.context('organization_id') AND id=atrium.context('property_id'));
CREATE POLICY enrollment_property_lock ON atrium.properties FOR UPDATE TO atrium_enrollment_executor USING(organization_id=atrium.context('organization_id') AND id=atrium.context('property_id')) WITH CHECK(false);
CREATE POLICY enrollment_configuration ON atrium.property_configurations FOR SELECT TO atrium_enrollment_executor USING(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id'));
CREATE POLICY enrollment_resident ON atrium.property_residents FOR SELECT TO atrium_enrollment_executor USING(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id'));
CREATE POLICY enrollment_resident_lock ON atrium.property_residents FOR UPDATE TO atrium_enrollment_executor USING(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id')) WITH CHECK(false);
CREATE POLICY enrollment_source ON atrium.resident_sources FOR SELECT TO atrium_enrollment_executor USING(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id'));
CREATE POLICY enrollment_no_channel ON atrium.channel_bindings FOR SELECT TO atrium_enrollment_executor USING(false);

CREATE FUNCTION atrium.enrollment_error(code text) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('error',code) $$;
CREATE FUNCTION atrium.enrollment_uuid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',false)
$$;
CREATE FUNCTION atrium.enrollment_digest(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT coalesce(jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[a-f0-9]{64}$',false) $$;
CREATE FUNCTION atrium.enrollment_version(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT coalesce(jsonb_typeof(v)='number' AND (v#>>'{}') ~ '^[1-9][0-9]{0,15}$' AND (v#>>'{}')::numeric<=9007199254740991,false) $$;
CREATE FUNCTION atrium.enrollment_time(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RETURN coalesce(jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND atrium.service_iso((v#>>'{}')::timestamptz)=(v#>>'{}'),false);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false; END $$;
CREATE FUNCTION atrium.enrollment_hash(v text) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT coalesce(v ~ '^scrypt\$65536\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$',false) $$;
CREATE FUNCTION atrium.enrollment_policy_json(p atrium.resident_enrollment_policies) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('organizationId',p.organization_id,'propertyId',p.property_id,'version',p.version,'enabled',p.enabled,'method',p.method,'protocol',p.protocol,
 'invitationLifetimeMinutes',p.invitation_lifetime_minutes,'sourceReference',p.source_reference,'observedAt',atrium.service_iso(p.observed_at),'validUntil',atrium.service_iso(p.valid_until),
 'publishedBy',p.published_by,'publishedAt',atrium.service_iso(p.published_at),'current',p.enabled AND p.observed_at<=clock_timestamp() AND p.valid_until>clock_timestamp())
$$;
CREATE FUNCTION atrium.enrollment_issuer_current(i atrium.resident_enrollment_invites) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM atrium.users u JOIN atrium.memberships m ON m.user_id=u.id AND m.organization_id=i.organization_id
 WHERE u.id=i.checked_by AND u.status='active' AND m.status='active' AND m.role IN ('owner','admin')
 AND (m.access='organization' OR EXISTS(SELECT 1 FROM atrium.property_grants g WHERE g.membership_id=m.id AND g.organization_id=i.organization_id AND g.property_id=i.property_id AND g.status='active')))
$$;
CREATE FUNCTION atrium.enrollment_context_current(org text,prop text,rid uuid,rv bigint,src uuid,pv bigint,cv bigint) RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM atrium.properties p JOIN atrium.organizations o ON o.id=p.organization_id
 JOIN atrium.property_configurations c ON c.organization_id=p.organization_id AND c.property_id=p.id AND c.version=p.published_configuration_version AND c.status='published'
 JOIN atrium.property_residents r ON r.organization_id=p.organization_id AND r.property_id=p.id
 JOIN atrium.resident_sources s ON s.organization_id=r.organization_id AND s.property_id=r.property_id AND s.id=r.source_id
 JOIN atrium.resident_enrollment_policies policy ON policy.organization_id=p.organization_id AND policy.property_id=p.id AND policy.version=pv
 WHERE p.organization_id=org AND p.id=prop AND p.status='active' AND o.status='active' AND p.published_configuration_version=cv
 AND r.id=rid AND r.version=rv AND r.source_id=src AND r.status='active'
 AND s.observed_at<=clock_timestamp() AND s.valid_until>clock_timestamp() AND (clock_timestamp() AT TIME ZONE p.time_zone)::date>=s.starts_on
 AND (s.ends_on IS NULL OR (clock_timestamp() AT TIME ZONE p.time_zone)::date<s.ends_on)
 AND policy.enabled AND policy.observed_at<=clock_timestamp() AND policy.valid_until>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM atrium.resident_enrollment_policies newer WHERE newer.organization_id=org AND newer.property_id=prop AND newer.version>pv)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.configuration->'inventory') unit WHERE unit->>'unitId'=r.unit_id)),false)
$$;
CREATE FUNCTION atrium.enrollment_invite_json(i atrium.resident_enrollment_invites) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',i.id,'version',i.version,'organizationId',i.organization_id,'propertyId',i.property_id,'residentId',i.resident_id,'residentVersion',i.resident_version,
 'policyVersion',i.policy_version,'configurationVersion',i.configuration_version,'createdAt',atrium.service_iso(i.created_at),'expiresAt',atrium.service_iso(i.expires_at),
 'checkedAt',atrium.service_iso(i.checked_at),'checkedBy',i.checked_by,'evidenceReference',i.evidence_reference,'deliveryStatus','not_sent',
 'state',CASE WHEN i.consumed_at IS NOT NULL THEN 'consumed' WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.expires_at<=clock_timestamp() THEN 'expired'
 WHEN NOT atrium.enrollment_context_current(i.organization_id,i.property_id,i.resident_id,i.resident_version,i.source_id,i.policy_version,i.configuration_version) OR NOT atrium.enrollment_issuer_current(i) THEN 'stale' ELSE 'pending' END)
$$;
CREATE FUNCTION atrium.enrollment_binding_json(b atrium.resident_account_bindings) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',b.id,'version',b.version,'organizationId',b.organization_id,'propertyId',b.property_id,'residentId',b.resident_id,'residentVersion',b.resident_version,
 'policyVersion',b.policy_version,'userId',b.user_id,'invitationId',b.invitation_id,'unitId',b.unit_id,'activatedAt',atrium.service_iso(b.activated_at),'revokedAt',atrium.service_iso(b.revoked_at),
 'state',CASE WHEN b.revoked_at IS NOT NULL THEN 'revoked' WHEN NOT EXISTS(SELECT 1 FROM atrium.users WHERE id=b.user_id AND status='active') THEN 'account_unavailable'
 WHEN NOT EXISTS(SELECT 1 FROM atrium.resident_enrollment_policies p WHERE p.organization_id=b.organization_id AND p.property_id=b.property_id AND p.version=b.policy_version
 AND p.enabled AND p.observed_at<=clock_timestamp() AND p.valid_until>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM atrium.resident_enrollment_policies n WHERE n.organization_id=p.organization_id AND n.property_id=p.property_id AND n.version>p.version)) THEN 'policy_changed'
 WHEN NOT atrium.enrollment_context_current(b.organization_id,b.property_id,b.resident_id,b.resident_version,b.source_id,b.policy_version,b.configuration_version) THEN 'context_changed' ELSE 'current' END)
$$;
CREATE FUNCTION atrium.enrollment_preserve() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='resident_enrollment_attempts' AND OLD.completed_at IS NULL AND OLD.expires_at<=clock_timestamp() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Enrollment evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='resident_enrollment_invites' THEN
  IF (to_jsonb(NEW)-ARRAY['version','revoked_at','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','revoked_at','consumed_at'])
   OR NEW.version<>OLD.version+1 OR OLD.revoked_at IS NOT NULL OR OLD.consumed_at IS NOT NULL
   OR (NEW.revoked_at IS NULL AND NEW.consumed_at IS NULL) THEN RAISE EXCEPTION 'Invitation evidence is immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='resident_account_bindings' THEN
  IF (to_jsonb(NEW)-ARRAY['version','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','revoked_at'])
   OR NEW.version<>OLD.version+1 OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'Binding evidence is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['completed_at','receipt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['completed_at','receipt'])
   OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN RAISE EXCEPTION 'Acceptance evidence is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER enrollment_invite_history BEFORE UPDATE OR DELETE ON atrium.resident_enrollment_invites FOR EACH ROW EXECUTE FUNCTION atrium.enrollment_preserve();
CREATE TRIGGER enrollment_binding_history BEFORE UPDATE OR DELETE ON atrium.resident_account_bindings FOR EACH ROW EXECUTE FUNCTION atrium.enrollment_preserve();
CREATE TRIGGER enrollment_attempt_history BEFORE UPDATE OR DELETE ON atrium.resident_enrollment_attempts FOR EACH ROW EXECUTE FUNCTION atrium.enrollment_preserve();
ALTER POLICY enrollment_identity ON atrium.users USING(
 id=atrium.context('actor_user_id') OR id=atrium.context('enrollment_new_user_id') OR EXISTS(SELECT 1 FROM atrium.memberships m WHERE m.user_id=users.id AND m.organization_id=atrium.context('organization_id'))
 OR EXISTS(SELECT 1 FROM atrium.resident_account_bindings b WHERE b.user_id=users.id AND b.organization_id=atrium.context('organization_id') AND b.property_id=atrium.context('property_id')));

CREATE FUNCTION atrium.enrollment_hold_resident() RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE u record; s record; BEGIN
 IF session_user<>'atrium_authenticator' OR atrium.context('session_audience') IS DISTINCT FROM 'resident'
 OR atrium.context('actor_user_id') IS NULL OR atrium.context('credential_version') IS NULL OR NOT atrium.enrollment_uuid(to_jsonb(atrium.context('session_id')))
 OR atrium.context('login_username') IS NOT NULL OR atrium.context('channel_provider') IS NOT NULL OR atrium.context('channel_external_id') IS NOT NULL
 OR atrium.context('channel_binding_id') IS NOT NULL OR atrium.context('channel_binding_version') IS NOT NULL THEN RETURN false; END IF;
 SELECT id,status,credential_version INTO u FROM atrium.users WHERE id=atrium.context('actor_user_id') FOR SHARE;
 IF NOT FOUND OR u.status<>'active' OR u.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RETURN false; END IF;
 SELECT id,revoked_at_ms,expires_at_ms INTO s FROM atrium.user_sessions WHERE id=atrium.context('session_id')::uuid AND user_id=u.id
 AND audience='resident' AND credential_version=u.credential_version FOR SHARE;
 RETURN FOUND AND s.revoked_at_ms IS NULL AND s.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000) AND atrium.mfa_login_allowed();
END $$;
CREATE FUNCTION atrium.enrollment_cleanup() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 DELETE FROM atrium.resident_enrollment_budgets b USING(SELECT kind,key FROM atrium.resident_enrollment_budgets
 WHERE last_reserved_at<=clock_timestamp()-interval '15 minutes' ORDER BY last_reserved_at,kind,key LIMIT 64 FOR UPDATE SKIP LOCKED) old
 WHERE b.kind=old.kind AND b.key=old.key;
 DELETE FROM atrium.resident_enrollment_attempts a USING(SELECT id FROM atrium.resident_enrollment_attempts WHERE completed_at IS NULL AND expires_at<=clock_timestamp()
 ORDER BY expires_at,id LIMIT 32 FOR UPDATE SKIP LOCKED) old WHERE a.id=old.id;
END $$;
CREATE FUNCTION atrium.enrollment_charge(token text,client text) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE k text; key_value text; times timestamptz[]; stamp timestamptz; acquired boolean; n integer; allowed boolean:=true; BEGIN
 -- Client-first ordering; an exhausted client cannot allocate arbitrary token rows.
 FOREACH k IN ARRAY ARRAY['client','token'] LOOP
  key_value:=CASE WHEN k='client' THEN client ELSE token END; acquired:=false;
  FOR n IN 1..3 LOOP
   INSERT INTO atrium.resident_enrollment_budgets(kind,key,last_reserved_at) VALUES(k,key_value,clock_timestamp()) ON CONFLICT DO NOTHING;
   SELECT attempts INTO times FROM atrium.resident_enrollment_budgets WHERE kind=k AND key=key_value FOR UPDATE;
   acquired:=FOUND; EXIT WHEN acquired;
  END LOOP;
  IF NOT acquired THEN RAISE EXCEPTION 'enrollment_unavailable' USING ERRCODE='P0001'; END IF;
  stamp:=clock_timestamp(); SELECT coalesce(array_agg(t ORDER BY t),'{}'::timestamptz[]) INTO times FROM unnest(times) t WHERE t>stamp-interval '15 minutes';
  IF cardinality(times)>=(CASE WHEN k='client' THEN 30 ELSE 10 END) THEN allowed:=false; EXIT; END IF;
  UPDATE atrium.resident_enrollment_budgets SET attempts=array_append(times,stamp),last_reserved_at=stamp WHERE kind=k AND key=key_value;
 END LOOP;
 PERFORM atrium.enrollment_cleanup(); RETURN allowed;
END $$;

CREATE FUNCTION atrium.enrollment_staff(p_action text,p_input jsonb,p_configuration bigint,p_proof uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE org text:=atrium.context('organization_id'); prop text:=atrium.context('property_id'); actor text:=atrium.context('actor_user_id'); command jsonb; material jsonb; action text;
 policy atrium.resident_enrollment_policies%ROWTYPE; resident atrium.property_residents%ROWTYPE; source atrium.resident_sources%ROWTYPE;
 invitation atrium.resident_enrollment_invites%ROWTYPE; binding atrium.resident_account_bindings%ROWTYPE; prior atrium.resident_enrollment_commands%ROWTYPE;
 stamp timestamptz(3); result jsonb; details jsonb; rid uuid; resource text; next_version bigint; zone text; expiry timestamptz(3); expected bigint;
BEGIN
 IF session_user<>'atrium_app' OR NOT coalesce(atrium.service_staff_context(),false) OR NOT atrium.hold_current_session()
 OR NOT atrium.can_access_property(org,prop,'operate') THEN RAISE EXCEPTION 'enrollment_forbidden' USING ERRCODE='P0001'; END IF;
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR pg_column_size(p_input)>20000 OR p_action NOT IN ('state','receipt','execute') OR p_action IS NULL
 OR p_configuration IS NULL OR p_configuration NOT BETWEEN 1 AND 9007199254740991 THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
 -- All staff commands serialize policy/invitation versions on the property before resident rows.
 IF p_action='execute' THEN
  IF NOT atrium.can_access_property(org,prop,'configure') OR NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'enrollment_forbidden' USING ERRCODE='P0001'; END IF;
  PERFORM 1 FROM atrium.properties WHERE organization_id=org AND id=prop AND published_configuration_version=p_configuration FOR UPDATE;
 ELSE PERFORM 1 FROM atrium.properties WHERE organization_id=org AND id=prop AND published_configuration_version=p_configuration FOR SHARE; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
 SELECT * INTO policy FROM atrium.resident_enrollment_policies WHERE organization_id=org AND property_id=prop ORDER BY version DESC LIMIT 1;
 IF p_action='state' THEN
  IF NOT atrium.service_keys(p_input,ARRAY['residentId']) OR NOT atrium.enrollment_uuid(p_input->'residentId') THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
  SELECT * INTO resident FROM atrium.property_residents WHERE organization_id=org AND property_id=prop AND id=(p_input->>'residentId')::uuid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
  SELECT * INTO source FROM atrium.resident_sources WHERE organization_id=org AND property_id=prop AND id=resident.source_id;
  SELECT * INTO invitation FROM atrium.resident_enrollment_invites WHERE organization_id=org AND property_id=prop AND resident_id=resident.id ORDER BY created_at DESC,id DESC LIMIT 1;
  SELECT * INTO binding FROM atrium.resident_account_bindings WHERE organization_id=org AND property_id=prop AND resident_id=resident.id ORDER BY activated_at DESC,id DESC LIMIT 1;
  result:=jsonb_build_object('policy',CASE WHEN policy.version IS NOT NULL THEN atrium.enrollment_policy_json(policy) END,
   'resident',jsonb_build_object('id',resident.id,'version',resident.version,'displayName',source.display_name,'unitId',resident.unit_id,'contextState',atrium.resident_context_state(resident)),
   'invitation',CASE WHEN invitation.id IS NOT NULL THEN atrium.enrollment_invite_json(invitation) END,'binding',CASE WHEN binding.id IS NOT NULL THEN atrium.enrollment_binding_json(binding) END,
   'canManage',atrium.can_access_property(org,prop,'configure'));
 ELSIF p_action='receipt' THEN
  IF NOT atrium.service_keys(p_input,ARRAY['requestId']) OR NOT atrium.enrollment_uuid(p_input->'requestId') THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
  SELECT receipt||jsonb_build_object('replayed',true) INTO result FROM atrium.resident_enrollment_commands WHERE organization_id=org AND property_id=prop AND actor_user_id=actor
   AND actor_credential_version::text=atrium.context('credential_version') AND request_id=(p_input->>'requestId')::uuid;
 ELSE
  IF NOT atrium.service_keys(p_input,ARRAY['command','material']) THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
  command:=p_input->'command';material:=p_input->'material';action:=command->>'action';
  IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR NOT atrium.enrollment_uuid(command->'requestId') OR NOT atrium.service_text(command->'reason',3,1000)
  OR jsonb_typeof(command->'action') IS DISTINCT FROM 'string' OR action NOT IN ('publish_policy','issue_invitation','revoke_invitation','revoke_binding') THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
  SELECT * INTO prior FROM atrium.resident_enrollment_commands WHERE organization_id=org AND property_id=prop AND actor_user_id=actor AND request_id=(command->>'requestId')::uuid;
  IF FOUND THEN
   IF prior.manifest<>command OR prior.actor_credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RAISE EXCEPTION 'enrollment_request_conflict' USING ERRCODE='P0001'; END IF;
   result:=prior.receipt||jsonb_build_object('replayed',true);
  ELSE
   stamp:=clock_timestamp();
   IF action='publish_policy' THEN
    details:=command->'details';
    IF NOT atrium.service_keys(command,ARRAY['action','requestId','expectedVersion','details','reason'])
    OR NOT (command->'expectedVersion'='null'::jsonb OR atrium.enrollment_version(command->'expectedVersion'))
    OR NOT atrium.service_keys(details,ARRAY['enabled','method','protocol','invitationLifetimeMinutes','sourceReference','observedAt','validUntil'])
    OR jsonb_typeof(details->'enabled') IS DISTINCT FROM 'boolean' OR details->>'method' IS DISTINCT FROM 'in_person_staff_check'
    OR NOT atrium.service_text(details->'protocol',20,2000) OR NOT atrium.service_text(details->'sourceReference',3,240)
    OR NOT atrium.enrollment_version(details->'invitationLifetimeMinutes') OR (details->>'invitationLifetimeMinutes')::int NOT BETWEEN 15 AND 1440
    OR NOT atrium.enrollment_time(details->'observedAt') OR NOT atrium.enrollment_time(details->'validUntil') THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
    IF policy.version IS DISTINCT FROM (command->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
    IF (details->>'validUntil')::timestamptz<=(details->>'observedAt')::timestamptz OR (details->>'validUntil')::timestamptz-(details->>'observedAt')::timestamptz>interval '90 days'
     OR (details->>'observedAt')::timestamptz>stamp OR ((details->>'enabled')::boolean AND (details->>'validUntil')::timestamptz<=stamp) THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
    next_version:=coalesce(policy.version,0)+1;resource:=prop;
    INSERT INTO atrium.resident_enrollment_policies VALUES(org,prop,next_version,(details->>'enabled')::boolean,'in_person_staff_check',details->>'protocol',
     (details->>'invitationLifetimeMinutes')::int,details->>'sourceReference',(details->>'observedAt')::timestamptz,(details->>'validUntil')::timestamptz,actor,stamp) RETURNING * INTO policy;
   ELSIF action='issue_invitation' THEN
    IF NOT atrium.service_keys(command,ARRAY['action','requestId','residentId','expectedResidentVersion','expectedPolicyVersion','replaces','checkedAt','evidenceReference','protocolCompleted','reason'])
    OR NOT atrium.enrollment_uuid(command->'residentId') OR NOT atrium.enrollment_version(command->'expectedResidentVersion') OR NOT atrium.enrollment_version(command->'expectedPolicyVersion')
    OR command->'protocolCompleted' IS DISTINCT FROM 'true'::jsonb OR NOT atrium.enrollment_time(command->'checkedAt') OR NOT atrium.service_text(command->'evidenceReference',3,240)
    OR NOT atrium.service_keys(material,ARRAY['id','tokenHash']) OR NOT atrium.enrollment_uuid(material->'id') OR NOT atrium.enrollment_digest(material->'tokenHash')
    THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
    SELECT * INTO resident FROM atrium.property_residents WHERE organization_id=org AND property_id=prop AND id=(command->>'residentId')::uuid FOR UPDATE;
    IF NOT FOUND OR resident.version<>(command->>'expectedResidentVersion')::bigint OR policy.version IS DISTINCT FROM (command->>'expectedPolicyVersion')::bigint
     OR NOT atrium.enrollment_context_current(org,prop,resident.id,resident.version,resident.source_id,policy.version,p_configuration)
     OR (command->>'checkedAt')::timestamptz>stamp OR (command->>'checkedAt')::timestamptz<=stamp-interval '24 hours'
     OR EXISTS(SELECT 1 FROM atrium.resident_account_bindings WHERE organization_id=org AND property_id=prop AND resident_id=resident.id AND revoked_at IS NULL)
    THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
    SELECT * INTO invitation FROM atrium.resident_enrollment_invites WHERE organization_id=org AND property_id=prop AND resident_id=resident.id AND revoked_at IS NULL AND consumed_at IS NULL FOR UPDATE;
    IF command->'replaces'='null'::jsonb THEN
     IF invitation.id IS NOT NULL THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
    ELSE
     IF NOT atrium.service_keys(command->'replaces',ARRAY['id','version']) OR NOT atrium.enrollment_uuid(command->'replaces'->'id') OR NOT atrium.enrollment_version(command->'replaces'->'version') THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
     IF invitation.id IS DISTINCT FROM (command->'replaces'->>'id')::uuid OR invitation.version IS DISTINCT FROM (command->'replaces'->>'version')::bigint THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
     UPDATE atrium.resident_enrollment_invites SET version=version+1,revoked_at=clock_timestamp() WHERE id=invitation.id;
     INSERT INTO atrium.resident_enrollment_events(organization_id,property_id,resident_id,operation,resource_id,resource_version,request_id,actor_user_id,actor_session_id,actor_credential_version,proof_id,reason)
     VALUES(org,prop,resident.id,'invitation.revoked',invitation.id::text,invitation.version+1,(command->>'requestId')::uuid,actor,atrium.context('session_id')::uuid,atrium.context('credential_version')::bigint,p_proof,command->>'reason');
    END IF;
    SELECT * INTO source FROM atrium.resident_sources WHERE organization_id=org AND property_id=prop AND id=resident.source_id;
    SELECT time_zone INTO zone FROM atrium.properties WHERE organization_id=org AND id=prop;
    expiry:=least(stamp+make_interval(mins=>policy.invitation_lifetime_minutes),(command->>'checkedAt')::timestamptz+interval '24 hours',policy.valid_until,source.valid_until,
      CASE WHEN source.ends_on IS NOT NULL THEN source.ends_on::timestamp AT TIME ZONE zone END);
    resource:=material->>'id';rid:=resident.id;next_version:=1;
    INSERT INTO atrium.resident_enrollment_invites(id,organization_id,property_id,resident_id,resident_version,source_id,policy_version,configuration_version,token_hash,checked_at,checked_by,evidence_reference,actor_session_id,actor_credential_version,proof_id,created_at,expires_at)
    VALUES(resource::uuid,org,prop,rid,resident.version,resident.source_id,policy.version,p_configuration,material->>'tokenHash',(command->>'checkedAt')::timestamptz,actor,command->>'evidenceReference',atrium.context('session_id')::uuid,atrium.context('credential_version')::bigint,p_proof,stamp,expiry) RETURNING * INTO invitation;
   ELSE
    IF NOT atrium.service_keys(command,ARRAY['action','requestId','id','expectedVersion','reason']) OR NOT atrium.enrollment_uuid(command->'id') OR NOT atrium.enrollment_version(command->'expectedVersion') THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
    resource:=command->>'id';expected:=(command->>'expectedVersion')::bigint;
    IF action='revoke_invitation' THEN
     SELECT * INTO invitation FROM atrium.resident_enrollment_invites WHERE organization_id=org AND property_id=prop AND id=resource::uuid FOR UPDATE;
     IF NOT FOUND OR invitation.version<>expected OR invitation.revoked_at IS NOT NULL OR invitation.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
     rid:=invitation.resident_id;next_version:=expected+1;UPDATE atrium.resident_enrollment_invites SET version=next_version,revoked_at=clock_timestamp() WHERE id=invitation.id;
    ELSE
     SELECT * INTO binding FROM atrium.resident_account_bindings WHERE organization_id=org AND property_id=prop AND id=resource::uuid FOR UPDATE;
     IF NOT FOUND OR binding.version<>expected OR binding.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
     rid:=binding.resident_id;next_version:=expected+1;UPDATE atrium.resident_account_bindings SET version=next_version,revoked_at=clock_timestamp() WHERE id=binding.id;
    END IF;
   END IF;
   result:=jsonb_build_object('action',action,'requestId',command->>'requestId','organizationId',org,'propertyId',prop,'actorUserId',actor,'id',resource,'version',next_version,'residentId',rid,'recordedAt',atrium.service_iso(stamp),'replayed',false);
   INSERT INTO atrium.resident_enrollment_commands VALUES(org,prop,actor,atrium.context('credential_version')::bigint,(command->>'requestId')::uuid,command,result);
   INSERT INTO atrium.resident_enrollment_events(organization_id,property_id,resident_id,operation,resource_id,resource_version,request_id,actor_user_id,actor_session_id,actor_credential_version,proof_id,reason,at)
   VALUES(org,prop,rid,CASE action WHEN 'publish_policy' THEN 'policy.published' WHEN 'issue_invitation' THEN 'invitation.issued' WHEN 'revoke_invitation' THEN 'invitation.revoked' ELSE 'binding.revoked' END,
    resource,next_version,(command->>'requestId')::uuid,actor,atrium.context('session_id')::uuid,atrium.context('credential_version')::bigint,p_proof,command->>'reason',stamp);
   IF action='publish_policy' AND policy.enabled AND policy.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
   IF action='issue_invitation' AND (invitation.expires_at<=clock_timestamp() OR NOT atrium.enrollment_context_current(org,prop,rid,invitation.resident_version,invitation.source_id,invitation.policy_version,p_configuration)) THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
  END IF;
  IF NOT atrium.can_access_property(org,prop,'configure') OR NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'enrollment_forbidden' USING ERRCODE='P0001'; END IF;
 END IF;
 IF NOT atrium.hold_current_session() OR NOT atrium.can_access_property(org,prop,'operate') THEN RAISE EXCEPTION 'enrollment_forbidden' USING ERRCODE='P0001'; END IF;
 RETURN coalesce(result,'null'::jsonb);
END $$;
CREATE FUNCTION atrium.enrollment_reservation_json(a atrium.resident_enrollment_attempts,p_hash text,p_version bigint) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',a.id,'requestId',a.request_id,'tokenHash',a.token_hash,'browserHash',a.browser_hash,'mode',a.mode,'invitationId',a.invitation_id,
 'invitationVersion',a.invitation_version,'userId',a.user_id,'username',a.username,'displayName',a.display_name,'credentialVersion',p_version,'sessionId',a.session_id,
 'passwordHash',p_hash,'expiresAt',atrium.service_iso(a.expires_at),'completedReceipt',CASE WHEN a.receipt IS NOT NULL THEN a.receipt||jsonb_build_object('replayed',true) END)
$$;
CREATE FUNCTION atrium.enrollment_resident(p_action text,p_input jsonb) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE constraint_name text; invitation atrium.resident_enrollment_invites%ROWTYPE; attempt atrium.resident_enrollment_attempts%ROWTYPE; resident atrium.property_residents%ROWTYPE;
 binding atrium.resident_account_bindings%ROWTYPE; source atrium.resident_sources%ROWTYPE; person record;
 token text; mode text; stamp timestamptz(3); original_hash text; selected_hash text; v bigint; result jsonb; row_json jsonb; provided jsonb;
 generated_user text; binding_key uuid; n integer; rows jsonb:='[]'; next_id uuid; selected_id uuid; parent_name text;
BEGIN
 IF session_user<>'atrium_authenticator' OR p_action IS NULL OR p_action NOT IN ('preview','reserve','accept_new','accept_existing','own_bindings','own_receipt')
 OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR pg_column_size(p_input)>20000 THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
 IF atrium.context('organization_id') IS NOT NULL OR atrium.context('property_id') IS NOT NULL OR atrium.context('login_username') IS NOT NULL
 OR atrium.context('channel_provider') IS NOT NULL OR atrium.context('channel_external_id') IS NOT NULL OR atrium.context('channel_binding_id') IS NOT NULL OR atrium.context('channel_binding_version') IS NOT NULL
 THEN RAISE EXCEPTION 'enrollment_unauthenticated' USING ERRCODE='P0001'; END IF;
 IF p_action IN ('own_bindings','own_receipt') THEN
  IF NOT atrium.enrollment_hold_resident() THEN RAISE EXCEPTION 'enrollment_unauthenticated' USING ERRCODE='P0001'; END IF;
  IF p_action='own_receipt' THEN
   IF NOT atrium.service_keys(p_input,ARRAY['requestId']) OR NOT atrium.enrollment_uuid(p_input->'requestId') THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
   SELECT receipt||jsonb_build_object('replayed',true) INTO result FROM atrium.resident_enrollment_attempts WHERE user_id=atrium.context('actor_user_id') AND request_id=(p_input->>'requestId')::uuid AND completed_at IS NOT NULL;
  ELSE
   IF NOT atrium.service_keys(p_input,ARRAY['limit','afterId']) OR NOT atrium.enrollment_version(p_input->'limit') OR (p_input->>'limit')::bigint>50
   OR NOT (p_input->'afterId'='null'::jsonb OR atrium.enrollment_uuid(p_input->'afterId')) THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
   n:=0;
   FOR selected_id IN SELECT id FROM atrium.resident_account_bindings WHERE user_id=atrium.context('actor_user_id') AND ((p_input->>'afterId') IS NULL OR id>(p_input->>'afterId')::uuid)
    ORDER BY id LIMIT (p_input->>'limit')::int+1 LOOP
    IF n=(p_input->>'limit')::int THEN EXIT; END IF;
    SELECT * INTO binding FROM atrium.resident_account_bindings WHERE id=selected_id AND user_id=atrium.context('actor_user_id');
    PERFORM set_config('atrium.organization_id',binding.organization_id,true);PERFORM set_config('atrium.property_id',binding.property_id,true);
    SELECT name INTO parent_name FROM atrium.properties WHERE organization_id=binding.organization_id AND id=binding.property_id FOR SHARE;
    PERFORM 1 FROM atrium.property_residents WHERE organization_id=binding.organization_id AND property_id=binding.property_id AND id=binding.resident_id FOR SHARE;
    SELECT * INTO binding FROM atrium.resident_account_bindings WHERE id=selected_id AND user_id=atrium.context('actor_user_id') FOR SHARE;
    rows:=rows||jsonb_build_array(atrium.enrollment_binding_json(binding)||jsonb_build_object('propertyName',parent_name));n:=n+1;next_id:=binding.id;
   END LOOP;
   IF n<(p_input->>'limit')::int OR NOT EXISTS(SELECT 1 FROM atrium.resident_account_bindings WHERE user_id=atrium.context('actor_user_id') AND id>next_id) THEN next_id:=NULL; END IF;
   result:=jsonb_build_object('items',rows,'nextId',next_id);
  END IF;
  IF NOT atrium.enrollment_hold_resident() THEN RAISE EXCEPTION 'enrollment_unauthenticated' USING ERRCODE='P0001'; END IF;
  RETURN coalesce(result,'null'::jsonb);
 END IF;
 IF p_action='reserve' THEN
  IF NOT atrium.service_keys(p_input,ARRAY['requestId','tokenHash','browserHash','clientKey','mode','expectedInvitationVersion','username','displayName'])
  OR NOT atrium.enrollment_uuid(p_input->'requestId') OR NOT atrium.enrollment_digest(p_input->'tokenHash') OR NOT atrium.enrollment_digest(p_input->'browserHash') OR NOT atrium.enrollment_digest(p_input->'clientKey')
  OR NOT atrium.enrollment_version(p_input->'expectedInvitationVersion') OR jsonb_typeof(p_input->'mode') IS DISTINCT FROM 'string' OR p_input->>'mode' NOT IN ('new','existing')
  OR NOT atrium.service_text(p_input->'username',3,64) OR p_input->>'username' !~ '^[a-z0-9][a-z0-9._-]{2,63}$' OR NOT atrium.service_text(p_input->'displayName',1,200)
  OR btrim(p_input->>'displayName')='' THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
  mode:=p_input->>'mode'; token:=p_input->>'tokenHash';
 ELSIF p_action='preview' THEN
  IF NOT atrium.service_keys(p_input,ARRAY['tokenHash']) OR NOT atrium.enrollment_digest(p_input->'tokenHash') THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
  mode:='new';token:=p_input->>'tokenHash';
 ELSE
  IF NOT atrium.service_keys(p_input,CASE WHEN p_action='accept_new' THEN ARRAY['reservation','passwordHash'] ELSE ARRAY['reservation'] END)
  THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
  provided:=p_input->'reservation';token:=provided->>'tokenHash';mode:=CASE WHEN p_action='accept_new' THEN 'new' ELSE 'existing' END;
  IF NOT atrium.service_keys(provided,ARRAY['id','requestId','tokenHash','browserHash','mode','invitationId','invitationVersion','userId','username','displayName','credentialVersion','sessionId','passwordHash','expiresAt','completedReceipt'])
  OR NOT atrium.enrollment_uuid(provided->'id') OR NOT atrium.enrollment_digest(provided->'tokenHash') OR provided->>'mode' IS DISTINCT FROM mode
  OR (p_action='accept_new' AND NOT atrium.enrollment_hash(p_input->>'passwordHash')) THEN RAISE EXCEPTION 'enrollment_invalid_input' USING ERRCODE='P0001'; END IF;
 END IF;
 IF mode='new' THEN
  IF atrium.context('actor_user_id') IS NOT NULL OR atrium.context('credential_version') IS NOT NULL OR atrium.context('session_id') IS NOT NULL OR atrium.context('session_audience') IS NOT NULL
   THEN RAISE EXCEPTION 'enrollment_unauthenticated' USING ERRCODE='P0001'; END IF;
 ELSE
  IF atrium.context('session_audience') IS DISTINCT FROM 'resident' OR atrium.context('actor_user_id') IS NULL OR atrium.context('credential_version') IS NULL OR atrium.context('session_id') IS NULL
   THEN RAISE EXCEPTION 'enrollment_unauthenticated' USING ERRCODE='P0001'; END IF;
 END IF;
 PERFORM set_config('atrium.enrollment_token_hash',token,true);
 IF p_action='reserve' AND NOT atrium.enrollment_charge(token,p_input->>'clientKey') THEN RETURN atrium.enrollment_error('enrollment_rate_limited'); END IF;
 SELECT * INTO invitation FROM atrium.resident_enrollment_invites WHERE token_hash=token;
 IF NOT FOUND THEN
  IF p_action='preview' THEN RETURN 'null'::jsonb; END IF;
  IF p_action='reserve' THEN RETURN atrium.enrollment_error('enrollment_invitation_unavailable'); END IF;
  RAISE EXCEPTION 'enrollment_invitation_unavailable' USING ERRCODE='P0001';
 END IF;
 PERFORM set_config('atrium.organization_id',invitation.organization_id,true);PERFORM set_config('atrium.property_id',invitation.property_id,true);
 IF p_action IN ('accept_new','accept_existing') THEN
  SELECT * INTO attempt FROM atrium.resident_enrollment_attempts WHERE id=(provided->>'id')::uuid AND token_hash=token;
  IF NOT FOUND OR attempt.mode<>mode THEN RAISE EXCEPTION 'enrollment_request_conflict' USING ERRCODE='P0001'; END IF;
  IF mode='new' THEN
   -- Global username uniqueness is settled before any property lock. Existing
   -- accounts are never selected by username or updated by this path.
   PERFORM pg_advisory_xact_lock(hashtextextended('atrium-enrollment-username:'||attempt.username,0));
   PERFORM set_config('atrium.enrollment_new_user_id',attempt.user_id,true);
  END IF;
 END IF;
 -- Discover immutable issuer before locks. Every existing account lock precedes
 -- accepting SID and property locks; never acquire another user after property.
 PERFORM 1 FROM atrium.users WHERE id=invitation.checked_by OR id=atrium.context('actor_user_id') OR id=atrium.context('enrollment_new_user_id') ORDER BY id FOR SHARE;
 IF mode='existing' AND NOT atrium.enrollment_hold_resident() THEN
  IF p_action='reserve' THEN RETURN atrium.enrollment_error('enrollment_unauthenticated'); END IF;
  RAISE EXCEPTION 'enrollment_unauthenticated' USING ERRCODE='P0001';
 END IF;
 -- Preserve the exact current hash/version across the cryptographic work.
 IF mode='existing' THEN
  SELECT u.id,u.username,u.display_name,u.credential_version,u.status,c.password_hash INTO person FROM atrium.users u JOIN atrium.user_credentials c ON c.user_id=u.id WHERE u.id=atrium.context('actor_user_id');
  original_hash:=person.password_hash;v:=person.credential_version;
 END IF;
 IF p_action='accept_new' AND attempt.completed_at IS NULL THEN
  IF provided IS DISTINCT FROM atrium.enrollment_reservation_json(attempt,NULL,attempt.credential_version) THEN RAISE EXCEPTION 'enrollment_request_conflict' USING ERRCODE='P0001'; END IF;
  BEGIN
   INSERT INTO atrium.users(id,username,display_name,status) VALUES(attempt.user_id,attempt.username,attempt.display_name,'active');
   INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES(attempt.user_id,p_input->>'passwordHash');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
    IF EXISTS(SELECT 1 FROM atrium.resident_enrollment_attempts WHERE id=attempt.id AND completed_at IS NOT NULL) THEN RAISE EXCEPTION 'enrollment_reconcile_required' USING ERRCODE='P0001'; END IF;
    IF constraint_name='users_username_key' THEN RAISE EXCEPTION 'enrollment_username_unavailable' USING ERRCODE='P0001'; END IF;
    RAISE EXCEPTION 'enrollment_reconcile_required' USING ERRCODE='P0001'; END;
 END IF;
 IF p_action IN ('reserve','accept_new','accept_existing') THEN
  PERFORM 1 FROM atrium.properties WHERE organization_id=invitation.organization_id AND id=invitation.property_id FOR UPDATE;
 ELSE PERFORM 1 FROM atrium.properties WHERE organization_id=invitation.organization_id AND id=invitation.property_id FOR SHARE; END IF;
 PERFORM 1 FROM atrium.resident_enrollment_policies WHERE organization_id=invitation.organization_id AND property_id=invitation.property_id AND version=invitation.policy_version;
 SELECT * INTO resident FROM atrium.property_residents WHERE organization_id=invitation.organization_id AND property_id=invitation.property_id AND id=invitation.resident_id FOR UPDATE;
 SELECT * INTO invitation FROM atrium.resident_enrollment_invites WHERE id=invitation.id FOR UPDATE;
 stamp:=clock_timestamp();
 IF p_action='reserve' THEN
  SELECT * INTO attempt FROM atrium.resident_enrollment_attempts WHERE request_id=(p_input->>'requestId')::uuid FOR UPDATE;
  IF FOUND THEN
   IF attempt.token_hash<>token OR attempt.browser_hash<>p_input->>'browserHash' OR attempt.mode<>mode OR attempt.username<>p_input->>'username'
    OR attempt.display_name<>p_input->>'displayName' OR attempt.invitation_version<>(p_input->>'expectedInvitationVersion')::bigint
    OR (mode='existing' AND (attempt.user_id IS DISTINCT FROM atrium.context('actor_user_id') OR attempt.session_id::text IS DISTINCT FROM atrium.context('session_id') OR attempt.credential_version<>v))
   THEN RETURN atrium.enrollment_error('enrollment_request_conflict'); END IF;
   IF attempt.expires_at<=stamp THEN RETURN atrium.enrollment_error('enrollment_reconcile_required'); END IF;
   IF attempt.completed_at IS NOT NULL THEN
    IF mode='new' THEN
     PERFORM set_config('atrium.enrollment_new_user_id',attempt.user_id,true);
     -- Receipt replay is read-only, authenticated by the resident's current
     -- password outside this transaction and rechecked at finalize.
     SELECT u.id,u.username,u.display_name,u.credential_version,u.status,c.password_hash INTO person FROM atrium.users u JOIN atrium.user_credentials c ON c.user_id=u.id WHERE u.id=attempt.user_id;
     IF NOT FOUND OR person.status<>'active' THEN RETURN atrium.enrollment_error('enrollment_unauthenticated'); END IF;
     original_hash:=person.password_hash;v:=person.credential_version;
    END IF;
    RETURN atrium.enrollment_reservation_json(attempt,original_hash,v);
   END IF;
  END IF;
 END IF;
 IF p_action IN ('accept_new','accept_existing') THEN
  SELECT * INTO attempt FROM atrium.resident_enrollment_attempts WHERE id=attempt.id FOR UPDATE;
  IF attempt.completed_at IS NOT NULL THEN
   IF provided->'completedReceipt'='null'::jsonb THEN RAISE EXCEPTION 'enrollment_reconcile_required' USING ERRCODE='P0001'; END IF;
   IF mode='new' THEN
    SELECT u.id,u.username,u.display_name,u.credential_version,u.status,c.password_hash INTO person FROM atrium.users u JOIN atrium.user_credentials c ON c.user_id=u.id WHERE u.id=attempt.user_id;
    original_hash:=person.password_hash;v:=person.credential_version;
   END IF;
   IF person.status IS DISTINCT FROM 'active' OR provided IS DISTINCT FROM atrium.enrollment_reservation_json(attempt,original_hash,v)
    OR (mode='new' AND p_input->>'passwordHash' IS DISTINCT FROM original_hash)
    OR attempt.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'enrollment_reconcile_required' USING ERRCODE='P0001'; END IF;
   IF mode='existing' AND NOT atrium.enrollment_hold_resident() THEN RAISE EXCEPTION 'enrollment_unauthenticated' USING ERRCODE='P0001'; END IF;
   RETURN attempt.receipt||jsonb_build_object('replayed',true);
  END IF;
 END IF;
 IF invitation.revoked_at IS NOT NULL OR invitation.consumed_at IS NOT NULL OR invitation.expires_at<=stamp OR NOT atrium.enrollment_issuer_current(invitation)
 OR NOT atrium.enrollment_context_current(invitation.organization_id,invitation.property_id,invitation.resident_id,invitation.resident_version,invitation.source_id,invitation.policy_version,invitation.configuration_version)
 THEN
  IF p_action='preview' THEN RETURN 'null'::jsonb; END IF;
  IF p_action='reserve' THEN RETURN atrium.enrollment_error('enrollment_invitation_unavailable'); END IF;
  RAISE EXCEPTION 'enrollment_invitation_unavailable' USING ERRCODE='P0001';
 END IF;
 IF p_action='preview' THEN
  SELECT * INTO source FROM atrium.resident_sources WHERE organization_id=invitation.organization_id AND property_id=invitation.property_id AND id=invitation.source_id;
  SELECT name INTO parent_name FROM atrium.properties WHERE organization_id=invitation.organization_id AND id=invitation.property_id;
  RETURN jsonb_build_object('invitationId',invitation.id,'invitationVersion',invitation.version,'propertyName',parent_name,'unitId',resident.unit_id,
   'recipientHint',left(source.display_name,1)||'…','expiresAt',atrium.service_iso(invitation.expires_at));
 ELSIF p_action='reserve' THEN
  IF invitation.version<>(p_input->>'expectedInvitationVersion')::bigint THEN RETURN atrium.enrollment_error('enrollment_changed'); END IF;
  IF mode='existing' THEN
   IF person.username IS DISTINCT FROM p_input->>'username' OR person.display_name IS DISTINCT FROM p_input->>'displayName' THEN RETURN atrium.enrollment_error('enrollment_changed'); END IF;
  END IF;
  IF attempt.id IS NULL THEN
   generated_user:=CASE WHEN mode='existing' THEN atrium.context('actor_user_id') ELSE 'resident-'||gen_random_uuid()::text END;
   INSERT INTO atrium.resident_enrollment_attempts(id,request_id,token_hash,browser_hash,mode,invitation_id,invitation_version,user_id,username,display_name,credential_version,session_id,credential_commitment,created_at,expires_at)
   VALUES(gen_random_uuid(),(p_input->>'requestId')::uuid,token,p_input->>'browserHash',mode,invitation.id,invitation.version,generated_user,p_input->>'username',p_input->>'displayName',
    CASE WHEN mode='existing' THEN v ELSE 1 END,CASE WHEN mode='existing' THEN atrium.context('session_id')::uuid END,
    CASE WHEN mode='existing' THEN encode(sha256(convert_to(original_hash,'UTF8')),'hex') END,stamp,least(stamp+interval '5 minutes',invitation.expires_at)) RETURNING * INTO attempt;
  END IF;
  IF mode='existing' AND (attempt.credential_commitment IS DISTINCT FROM encode(sha256(convert_to(original_hash,'UTF8')),'hex') OR NOT atrium.enrollment_hold_resident()) THEN RETURN atrium.enrollment_error('enrollment_unauthenticated'); END IF;
  RETURN atrium.enrollment_reservation_json(attempt,CASE WHEN mode='existing' THEN original_hash END,attempt.credential_version);
 END IF;
 IF attempt.expires_at<=stamp OR attempt.invitation_id<>invitation.id OR attempt.invitation_version<>invitation.version
 OR (mode='existing' AND (attempt.user_id IS DISTINCT FROM atrium.context('actor_user_id') OR attempt.session_id::text IS DISTINCT FROM atrium.context('session_id')
  OR attempt.credential_version<>v OR attempt.credential_commitment IS DISTINCT FROM encode(sha256(convert_to(original_hash,'UTF8')),'hex')
  OR provided IS DISTINCT FROM atrium.enrollment_reservation_json(attempt,original_hash,v))) THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM atrium.resident_account_bindings WHERE organization_id=invitation.organization_id AND property_id=invitation.property_id AND resident_id=invitation.resident_id AND revoked_at IS NULL)
 THEN RAISE EXCEPTION 'enrollment_changed' USING ERRCODE='P0001'; END IF;
 binding_key:=gen_random_uuid();
 INSERT INTO atrium.resident_account_bindings(id,organization_id,property_id,resident_id,resident_version,source_id,policy_version,configuration_version,user_id,invitation_id,unit_id,activated_at)
 VALUES(binding_key,invitation.organization_id,invitation.property_id,invitation.resident_id,invitation.resident_version,invitation.source_id,invitation.policy_version,invitation.configuration_version,attempt.user_id,invitation.id,resident.unit_id,stamp);
 UPDATE atrium.resident_enrollment_invites SET version=version+1,consumed_at=stamp WHERE id=invitation.id;
 result:=jsonb_build_object('requestId',attempt.request_id,'invitationId',invitation.id,'bindingId',binding_key,'bindingVersion',1,'organizationId',invitation.organization_id,
 'propertyId',invitation.property_id,'residentId',invitation.resident_id,'userId',attempt.user_id,'activatedAt',atrium.service_iso(stamp),'replayed',false);
 UPDATE atrium.resident_enrollment_attempts SET completed_at=stamp,receipt=result WHERE id=attempt.id;
 INSERT INTO atrium.resident_enrollment_events(organization_id,property_id,resident_id,operation,resource_id,resource_version,request_id,actor_user_id,actor_session_id,actor_credential_version,at)
 VALUES(invitation.organization_id,invitation.property_id,invitation.resident_id,'binding.activated',binding_key::text,1,attempt.request_id,attempt.user_id,attempt.session_id,attempt.credential_version,stamp);
 IF invitation.expires_at<=clock_timestamp() OR attempt.expires_at<=clock_timestamp() OR NOT atrium.enrollment_issuer_current(invitation)
 OR NOT atrium.enrollment_context_current(invitation.organization_id,invitation.property_id,invitation.resident_id,invitation.resident_version,invitation.source_id,invitation.policy_version,invitation.configuration_version)
 THEN RAISE EXCEPTION 'enrollment_invitation_unavailable' USING ERRCODE='P0001'; END IF;
 IF mode='existing' AND NOT atrium.enrollment_hold_resident() THEN RAISE EXCEPTION 'enrollment_unauthenticated' USING ERRCODE='P0001'; END IF;
 RETURN result;
END $$;

GRANT USAGE,CREATE ON SCHEMA atrium TO atrium_enrollment_executor;
GRANT USAGE ON TYPE atrium.record_id,atrium.positive_version TO atrium_enrollment_executor;
GRANT SELECT,INSERT ON atrium.resident_enrollment_policies,atrium.resident_enrollment_commands,atrium.resident_enrollment_events TO atrium_enrollment_executor;
GRANT SELECT,INSERT,UPDATE ON atrium.resident_enrollment_invites,atrium.resident_account_bindings TO atrium_enrollment_executor;
GRANT SELECT,INSERT,UPDATE,DELETE ON atrium.resident_enrollment_attempts,atrium.resident_enrollment_budgets TO atrium_enrollment_executor;
GRANT SELECT(id,username,display_name,status,credential_version),INSERT(id,username,display_name,status),UPDATE(id) ON atrium.users TO atrium_enrollment_executor;
GRANT SELECT(user_id,password_hash),INSERT(user_id,password_hash) ON atrium.user_credentials TO atrium_enrollment_executor;
GRANT SELECT(id,user_id,audience,credential_version,revoked_at_ms,expires_at_ms),UPDATE(id) ON atrium.user_sessions TO atrium_enrollment_executor;
GRANT SELECT ON atrium.memberships,atrium.property_grants,atrium.organizations,atrium.properties,atrium.property_configurations,atrium.channel_bindings,atrium.property_residents,atrium.resident_sources TO atrium_enrollment_executor;
GRANT UPDATE(id) ON atrium.properties,atrium.property_residents TO atrium_enrollment_executor;
GRANT EXECUTE ON FUNCTION atrium.context(text),atrium.staff_context(),atrium.session_context_valid(),atrium.service_staff_context(),atrium.hold_current_session(),atrium.can_access_property(text,text,text),
 atrium.staff_property_permission(text,text,text),atrium.channel_property_permission(text,text,text),atrium.channel_context(),atrium.mfa_login_allowed(),atrium.mfa_hold_proof(uuid,text),
 atrium.service_iso(timestamptz),atrium.service_keys(jsonb,text[]),atrium.service_text(jsonb,integer,integer,boolean),atrium.resident_context_state(atrium.property_residents),atrium.keep_workflow_evidence() TO atrium_enrollment_executor;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='atrium' AND p.proname LIKE 'enrollment_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,atrium_app,atrium_authenticator',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO atrium_enrollment_executor',f);
 END LOOP;
END $$;
ALTER FUNCTION atrium.enrollment_staff(text,jsonb,bigint,uuid) OWNER TO atrium_enrollment_executor;
ALTER FUNCTION atrium.enrollment_resident(text,jsonb) OWNER TO atrium_enrollment_executor;
GRANT EXECUTE ON FUNCTION atrium.enrollment_staff(text,jsonb,bigint,uuid) TO atrium_app;
GRANT EXECUTE ON FUNCTION atrium.enrollment_resident(text,jsonb) TO atrium_authenticator;
REVOKE CREATE ON SCHEMA atrium FROM atrium_enrollment_executor;
RESET ROLE;
