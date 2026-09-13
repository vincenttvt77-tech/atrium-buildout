-- Exact property-funded work and entry consent. No command here dispatches a job.
SET LOCAL ROLE atrium_admin;
CREATE TABLE atrium.consent_policies (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, version atrium.positive_version NOT NULL,
 enabled boolean NOT NULL, require_work_consent boolean NOT NULL, no_charge_statement text NOT NULL CHECK(length(no_charge_statement) BETWEEN 20 AND 1000),
 recipient_protocol text NOT NULL CHECK(length(recipient_protocol) BETWEEN 20 AND 2000), entry_protocol text NOT NULL CHECK(length(entry_protocol) BETWEEN 20 AND 2000),
 maximum_response_minutes integer NOT NULL CHECK(maximum_response_minutes BETWEEN 1 AND 10080), maximum_consent_minutes integer NOT NULL CHECK(maximum_consent_minutes BETWEEN 1 AND 43200), maximum_entry_minutes integer NOT NULL CHECK(maximum_entry_minutes BETWEEN 1 AND 1440),
 help_label text NOT NULL CHECK(length(help_label) BETWEEN 3 AND 120), help_phone text NOT NULL CHECK(help_phone ~ '^\+[1-9][0-9]{6,14}$'), help_url text,
 emergency_instructions text NOT NULL CHECK(length(emergency_instructions) BETWEEN 20 AND 2000),
 source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 3 AND 240), source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 80), observed_at timestamptz(3) NOT NULL, valid_until timestamptz(3) NOT NULL,
 published_by atrium.record_id NOT NULL REFERENCES atrium.users(id), published_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,version), FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id),
 CHECK(valid_until>observed_at AND valid_until-observed_at<=interval '90 days'), CHECK(help_url IS NULL OR (length(help_url)<=2000 AND help_url ~ '^https://[^/@[:space:]]+'))
);
CREATE TABLE atrium.consent_rosters (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, version atrium.positive_version NOT NULL,
 unit_id atrium.record_id NOT NULL, policy_version atrium.positive_version NOT NULL, residency_digest text NOT NULL CHECK(residency_digest ~ '^[a-f0-9]{64}$'),
 source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 3 AND 240), source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 80), observed_at timestamptz(3) NOT NULL, valid_until timestamptz(3) NOT NULL,
 reviewed_by atrium.record_id NOT NULL REFERENCES atrium.users(id), reviewed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,id,version), UNIQUE(organization_id,property_id,unit_id,version),
 FOREIGN KEY(organization_id,property_id,policy_version) REFERENCES atrium.consent_policies(organization_id,property_id,version), CHECK(valid_until>observed_at AND valid_until-observed_at<=interval '90 days')
);
CREATE TABLE atrium.consent_roster_members (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, roster_id uuid NOT NULL, roster_version atrium.positive_version NOT NULL,
 resident_id uuid NOT NULL, resident_version atrium.positive_version NOT NULL, required_purposes text[] NOT NULL CHECK(required_purposes <@ ARRAY['work','entry']::text[] AND cardinality(required_purposes)<=2 AND array_position(required_purposes,NULL) IS NULL),
 PRIMARY KEY(organization_id,property_id,roster_id,roster_version,resident_id),
 FOREIGN KEY(organization_id,property_id,roster_id,roster_version) REFERENCES atrium.consent_rosters(organization_id,property_id,id,version),
 FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id)
);
CREATE TABLE atrium.consent_authorities (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, version atrium.positive_version NOT NULL,
 binding_id uuid NOT NULL, binding_version atrium.positive_version NOT NULL, resident_id uuid NOT NULL, resident_version atrium.positive_version NOT NULL,
 user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), unit_id atrium.record_id NOT NULL, purpose text NOT NULL CHECK(purpose IN ('work','entry')), policy_version atrium.positive_version NOT NULL,
 source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 3 AND 240), source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 80), observed_at timestamptz(3) NOT NULL, valid_until timestamptz(3) NOT NULL,
 reviewed_by atrium.record_id NOT NULL REFERENCES atrium.users(id), reviewed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz(3),
 PRIMARY KEY(organization_id,property_id,id,version), UNIQUE(organization_id,property_id,binding_id,purpose,version),
 FOREIGN KEY(organization_id,property_id,binding_id) REFERENCES atrium.resident_account_bindings(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,policy_version) REFERENCES atrium.consent_policies(organization_id,property_id,version), CHECK(valid_until>observed_at AND valid_until-observed_at<=interval '90 days')
);
CREATE TABLE atrium.consent_requests (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, version atrium.positive_version NOT NULL, case_id uuid NOT NULL, purpose text NOT NULL CHECK(purpose IN ('work','entry')),
 case_version atrium.positive_version NOT NULL, plan_id uuid NOT NULL, plan_version atrium.positive_version NOT NULL, configuration_version atrium.positive_version NOT NULL,
 maintenance_policy_version atrium.positive_version NOT NULL, consent_policy_version atrium.positive_version NOT NULL, roster_id uuid NOT NULL, roster_version atrium.positive_version NOT NULL,
 material_digest text NOT NULL CHECK(material_digest ~ '^[a-f0-9]{64}$'), terms_digest text NOT NULL CHECK(terms_digest ~ '^[a-f0-9]{64}$'), terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object' AND pg_column_size(terms)<=16384),
 response_deadline timestamptz(3) NOT NULL, consent_valid_until timestamptz(3) NOT NULL, published_by atrium.record_id NOT NULL REFERENCES atrium.users(id), published_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), withdrawn_at timestamptz(3), history_id uuid NOT NULL DEFAULT gen_random_uuid(),
 PRIMARY KEY(organization_id,property_id,id,version), UNIQUE(organization_id,property_id,case_id,purpose,version),
 FOREIGN KEY(organization_id,property_id,case_id) REFERENCES atrium.service_cases(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,plan_id,plan_version) REFERENCES atrium.maintenance_plans(organization_id,property_id,id,version),
 FOREIGN KEY(organization_id,property_id,consent_policy_version) REFERENCES atrium.consent_policies(organization_id,property_id,version),
 FOREIGN KEY(organization_id,property_id,roster_id,roster_version) REFERENCES atrium.consent_rosters(organization_id,property_id,id,version), CHECK(response_deadline<=consent_valid_until)
);
CREATE TABLE atrium.consent_recipients (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, request_id uuid NOT NULL, request_version atrium.positive_version NOT NULL,
 resident_id uuid NOT NULL, resident_version atrium.positive_version NOT NULL, binding_id uuid NOT NULL, binding_version atrium.positive_version NOT NULL, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), authority_id uuid NOT NULL, authority_version atrium.positive_version NOT NULL, purpose text NOT NULL CHECK(purpose IN ('work','entry')),
 PRIMARY KEY(organization_id,property_id,request_id,request_version,resident_id), UNIQUE(organization_id,property_id,request_id,request_version,user_id),
 FOREIGN KEY(organization_id,property_id,request_id,request_version) REFERENCES atrium.consent_requests(organization_id,property_id,id,version),
 FOREIGN KEY(organization_id,property_id,authority_id,authority_version) REFERENCES atrium.consent_authorities(organization_id,property_id,id,version)
);
CREATE TABLE atrium.consent_decisions (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL, request_version atrium.positive_version NOT NULL, purpose text NOT NULL CHECK(purpose IN ('work','entry')),
 actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_credential_version atrium.positive_version NOT NULL, actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id), version atrium.positive_version NOT NULL,
 decision text NOT NULL CHECK(decision IN ('grant','decline','revoke')), grant_id uuid, terms_digest text NOT NULL, factor_id uuid REFERENCES atrium.mfa_factors(id), factor_counter_revision atrium.positive_version, security_version atrium.positive_version,
 command_id uuid NOT NULL, decided_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,id), UNIQUE(organization_id,property_id,request_id,request_version,actor_user_id,version),
 FOREIGN KEY(organization_id,property_id,request_id,request_version) REFERENCES atrium.consent_requests(organization_id,property_id,id,version),
 CHECK((decision='grant' AND factor_id IS NOT NULL AND factor_counter_revision IS NOT NULL AND security_version IS NOT NULL AND grant_id=id) OR (decision<>'grant' AND factor_id IS NULL AND factor_counter_revision IS NULL AND security_version IS NULL)),
 CHECK((decision='decline')=(grant_id IS NULL))
);
CREATE TABLE atrium.consent_commands (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, case_id uuid NOT NULL, actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_credential_version atrium.positive_version NOT NULL, actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id),
 command_id uuid NOT NULL, manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND pg_column_size(manifest)<=32768), receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'), committed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_user_id,command_id), FOREIGN KEY(organization_id,property_id,case_id) REFERENCES atrium.service_cases(organization_id,property_id,id)
);
CREATE TABLE atrium.consent_ceremonies (
 id uuid PRIMARY KEY, organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), session_id uuid NOT NULL REFERENCES atrium.user_sessions(id), credential_version atrium.positive_version NOT NULL, security_version atrium.positive_version NOT NULL,
 request_id uuid NOT NULL, request_version atrium.positive_version NOT NULL, command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND pg_column_size(command)<=4096), challenge_hash text NOT NULL CHECK(challenge_hash ~ '^[a-f0-9]{64}$'),
 origin text NOT NULL, rp_id text NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz(3) NOT NULL, attempt_id uuid, claim jsonb, consumed_at timestamptz(3),
 FOREIGN KEY(organization_id,property_id,request_id,request_version) REFERENCES atrium.consent_requests(organization_id,property_id,id,version), CHECK(expires_at>created_at AND expires_at-created_at<=interval '5 minutes'), CHECK((attempt_id IS NULL)=(claim IS NULL))
);
CREATE TABLE atrium.consent_budgets (user_id atrium.record_id PRIMARY KEY REFERENCES atrium.users(id), attempts timestamptz[] NOT NULL CHECK(cardinality(attempts)<=60 AND array_position(attempts,NULL) IS NULL), last_reserved_at timestamptz NOT NULL);
CREATE INDEX consent_request_case ON atrium.consent_requests(organization_id,property_id,case_id,purpose,version DESC);
CREATE INDEX consent_recipient_own ON atrium.consent_recipients(user_id,request_id,request_version DESC);
CREATE INDEX consent_decision_own ON atrium.consent_decisions(actor_user_id,request_id,request_version,version DESC);
CREATE INDEX consent_ceremony_expiry ON atrium.consent_ceremonies(expires_at);
CREATE INDEX consent_budget_expiry ON atrium.consent_budgets(last_reserved_at);

-- Tables have no runtime grants. These policies constrain only the finite executor;
-- an arbitrary client-set context is never accepted as resident admission.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['consent_policies','consent_rosters','consent_roster_members','consent_authorities','consent_requests','consent_recipients','consent_decisions','consent_commands','consent_ceremonies','consent_budgets'] LOOP
  EXECUTE format('ALTER TABLE atrium.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE atrium.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON atrium.%I FROM PUBLIC,atrium_app,atrium_authenticator',t);
  EXECUTE format('CREATE POLICY maintenance ON atrium.%I TO atrium_admin USING(true) WITH CHECK(true)',t);
  IF t NOT IN ('consent_ceremonies','consent_budgets') THEN EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON atrium.%I FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence()',t); END IF;
  IF t<>'consent_budgets' THEN EXECUTE format('CREATE POLICY consent_scope ON atrium.%I TO atrium_consent_executor USING(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id'')) WITH CHECK(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id''))',t); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['properties','property_configurations','property_residents','resident_sources','resident_account_bindings','resident_enrollment_policies','maintenance_policies','maintenance_vendors','maintenance_plans','maintenance_decisions','service_cases','memberships','property_grants'] LOOP
  EXECUTE format('CREATE POLICY consent_read ON atrium.%I FOR SELECT TO atrium_consent_executor USING(organization_id=atrium.context(''organization_id'')%s)',t,
   CASE WHEN t='memberships' THEN '' WHEN t='properties' THEN ' AND id=atrium.context(''property_id'')' ELSE ' AND property_id=atrium.context(''property_id'')' END);
 END LOOP;
END $$;
CREATE FUNCTION atrium.consent_effectiveness(g jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h text[]:='{}'; q jsonb:=g->'request'; r jsonb; stamp timestamptz(3):=clock_timestamp(); deadline timestamptz; refresh timestamptz; incomplete boolean:=false; required boolean:=coalesce((g->>'required')::boolean,true); BEGIN
 SELECT coalesce(array_agg(value),'{}') INTO h FROM jsonb_array_elements_text(g->'holds');
 FOR r IN SELECT * FROM jsonb_array_elements(g->'deadlines') LOOP
  IF r='null'::jsonb THEN h:=array_append(h,'context_changed'); CONTINUE; END IF; deadline:=(r#>>'{}')::timestamptz;
  IF deadline<=stamp THEN h:=array_append(h,'context_changed'); ELSE refresh:=least(refresh,deadline); END IF;
 END LOOP;
 IF NOT required THEN h:=ARRAY['not_required']; ELSE
  IF q IS NULL OR q='null'::jsonb THEN h:=array_append(h,'awaiting_decisions'); ELSE
   IF q->'withdrawnAt'<>'null'::jsonb THEN h:=array_append(h,'request_withdrawn'); END IF;
   IF (q->>'consentValidUntil')::timestamptz<=stamp THEN h:=array_append(h,'consent_expired'); ELSE refresh:=least(refresh,(q->>'consentValidUntil')::timestamptz); END IF;
   IF (q->>'responseDeadline')::timestamptz>stamp THEN refresh:=least(refresh,(q->>'responseDeadline')::timestamptz); END IF;
   IF q->>'purpose'='entry' THEN
    IF q#>'{terms,entryWindow}'='null'::jsonb THEN h:=array_append(h,'missing_entry_window');
    ELSIF (q#>>'{terms,entryWindow,endsAt}')::timestamptz<=stamp THEN h:=array_append(h,'entry_expired'); ELSE refresh:=least(refresh,(q#>>'{terms,entryWindow,endsAt}')::timestamptz); END IF;
   END IF;
  END IF;
  IF jsonb_array_length(g->'recipients')=0 THEN h:=array_append(h,'missing_required_recipient');incomplete:=true; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(g->'recipients') LOOP
   h:=h||ARRAY(SELECT jsonb_array_elements_text(r->'holds'));
   IF r->'decision'='null'::jsonb THEN h:=array_append(h,'awaiting_decisions');incomplete:=true;
   ELSIF r#>>'{decision,decision}'='decline' THEN h:=array_append(h,'declined');incomplete:=true;
   ELSIF r#>>'{decision,decision}'='revoke' THEN h:=array_append(h,'revoked');incomplete:=true;
   ELSIF r#>>'{decision,actorUserId}' IS DISTINCT FROM r->>'userId' OR r#>>'{decision,termsDigest}' IS DISTINCT FROM q->>'termsDigest' OR r#>>'{decision,grantId}' IS DISTINCT FROM r#>>'{decision,id}' OR (r#>>'{decision,decidedAt}')::timestamptz>=(q->>'responseDeadline')::timestamptz THEN h:=array_append(h,'terms_changed'); END IF;
  END LOOP;
  IF incomplete AND (q->>'responseDeadline')::timestamptz<=stamp THEN h:=array_append(h,'response_expired'); END IF;
 END IF;
 RETURN jsonb_build_object('required',required,'effective',required AND cardinality(h)=0,'holds',to_jsonb(ARRAY(SELECT DISTINCT v FROM unnest(h) v ORDER BY v)),'evaluatedAt',atrium.service_iso(stamp),'refreshAt',atrium.service_iso(refresh),'dispatchStatus','not_dispatched','notificationStatus','not_sent');
END $$;
CREATE POLICY consent_own_recipients ON atrium.consent_recipients FOR SELECT TO atrium_consent_executor USING(user_id=atrium.context('actor_user_id'));
CREATE POLICY consent_own_requests ON atrium.consent_requests FOR SELECT TO atrium_consent_executor USING(EXISTS(SELECT 1 FROM atrium.consent_recipients r WHERE r.request_id=consent_requests.id AND r.request_version=consent_requests.version AND r.organization_id=consent_requests.organization_id AND r.property_id=consent_requests.property_id AND r.user_id=atrium.context('actor_user_id')));
CREATE POLICY consent_own_decisions ON atrium.consent_decisions FOR SELECT TO atrium_consent_executor USING(actor_user_id=atrium.context('actor_user_id'));
CREATE POLICY consent_own_commands ON atrium.consent_commands FOR SELECT TO atrium_consent_executor USING(actor_user_id=atrium.context('actor_user_id'));
CREATE POLICY consent_own_ceremonies ON atrium.consent_ceremonies TO atrium_consent_executor USING(user_id=atrium.context('actor_user_id')) WITH CHECK(user_id=atrium.context('actor_user_id'));
CREATE POLICY consent_budget ON atrium.consent_budgets TO atrium_consent_executor USING(true) WITH CHECK(user_id=atrium.context('actor_user_id'));
CREATE POLICY consent_users ON atrium.users FOR SELECT TO atrium_consent_executor USING(id=atrium.context('actor_user_id') OR EXISTS(SELECT 1 FROM atrium.memberships m WHERE m.organization_id=atrium.context('organization_id') AND m.user_id=users.id) OR EXISTS(SELECT 1 FROM atrium.resident_account_bindings b WHERE b.organization_id=atrium.context('organization_id') AND b.property_id=atrium.context('property_id') AND b.user_id=users.id));
CREATE POLICY consent_user_lock ON atrium.users FOR UPDATE TO atrium_consent_executor USING(id=atrium.context('actor_user_id') OR EXISTS(SELECT 1 FROM atrium.memberships m WHERE m.organization_id=atrium.context('organization_id') AND m.user_id=users.id) OR EXISTS(SELECT 1 FROM atrium.resident_account_bindings b WHERE b.organization_id=atrium.context('organization_id') AND b.property_id=atrium.context('property_id') AND b.user_id=users.id)) WITH CHECK(false);
CREATE POLICY consent_org ON atrium.organizations FOR SELECT TO atrium_consent_executor USING(id=atrium.context('organization_id'));
CREATE POLICY consent_org_lock ON atrium.organizations FOR UPDATE TO atrium_consent_executor USING(id=atrium.context('organization_id')) WITH CHECK(false);
CREATE POLICY consent_property_lock ON atrium.properties FOR UPDATE TO atrium_consent_executor USING(organization_id=atrium.context('organization_id') AND id=atrium.context('property_id')) WITH CHECK(false);
CREATE POLICY consent_session ON atrium.user_sessions FOR SELECT TO atrium_consent_executor USING(user_id=atrium.context('actor_user_id') AND id::text=atrium.context('session_id') AND credential_version::text=atrium.context('credential_version') AND audience=atrium.context('session_audience'));
CREATE POLICY consent_session_lock ON atrium.user_sessions FOR UPDATE TO atrium_consent_executor USING(user_id=atrium.context('actor_user_id') AND id::text=atrium.context('session_id')) WITH CHECK(false);
CREATE POLICY consent_state ON atrium.mfa_states FOR SELECT TO atrium_consent_executor USING(user_id=atrium.context('actor_user_id'));
CREATE POLICY consent_state_lock ON atrium.mfa_states FOR UPDATE TO atrium_consent_executor USING(user_id=atrium.context('actor_user_id')) WITH CHECK(false);
CREATE POLICY consent_factor ON atrium.mfa_factors FOR SELECT TO atrium_consent_executor USING(user_id=atrium.context('actor_user_id') OR EXISTS(SELECT 1 FROM atrium.consent_recipients r WHERE r.organization_id=atrium.context('organization_id') AND r.property_id=atrium.context('property_id') AND r.user_id=mfa_factors.user_id));
CREATE POLICY consent_factor_update ON atrium.mfa_factors FOR UPDATE TO atrium_consent_executor USING(user_id=atrium.context('actor_user_id') AND status='active') WITH CHECK(user_id=atrium.context('actor_user_id') AND status='active');
CREATE POLICY consent_no_channel ON atrium.channel_bindings FOR SELECT TO atrium_consent_executor USING(false);

CREATE FUNCTION atrium.consent_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex') $$;
CREATE FUNCTION atrium.consent_source_json(ref text,ver text,seen timestamptz,until_at timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('reference',ref,'version',ver,'observedAt',atrium.service_iso(seen),'validUntil',atrium.service_iso(until_at)) $$;
CREATE FUNCTION atrium.consent_source_valid(v jsonb) RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT atrium.service_keys(v,ARRAY['reference','version','observedAt','validUntil']) AND atrium.service_text(v->'reference',3,240,false) AND atrium.service_text(v->'version',1,80,false)
 AND atrium.enrollment_time(v->'observedAt') AND atrium.enrollment_time(v->'validUntil') AND (v->>'observedAt')::timestamptz<=clock_timestamp() AND (v->>'validUntil')::timestamptz>clock_timestamp()
 AND (v->>'validUntil')::timestamptz>(v->>'observedAt')::timestamptz AND (v->>'validUntil')::timestamptz-(v->>'observedAt')::timestamptz<=interval '90 days'
$$;
CREATE FUNCTION atrium.consent_user_ids(cid uuid) RETURNS text[] LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 WITH c AS(SELECT * FROM atrium.service_cases WHERE id=cid), p AS(SELECT * FROM atrium.maintenance_plans WHERE case_id=cid ORDER BY version DESC LIMIT 1),
 roster AS(SELECT r.* FROM atrium.consent_rosters r,c WHERE r.unit_id=c.unit_id ORDER BY version DESC LIMIT 1),
 authorities AS(SELECT DISTINCT ON(a.id) a.* FROM atrium.consent_authorities a,c WHERE a.unit_id=c.unit_id ORDER BY a.id,a.version DESC),
 ids AS(SELECT atrium.context('actor_user_id') id UNION SELECT prepared_by FROM p UNION SELECT actor_user_id FROM atrium.maintenance_decisions d JOIN p ON d.plan_id=p.id AND d.plan_version=p.version
 UNION SELECT published_by FROM(SELECT published_by FROM atrium.maintenance_policies ORDER BY version DESC LIMIT 1) q
 UNION SELECT published_by FROM(SELECT published_by FROM atrium.consent_policies ORDER BY version DESC LIMIT 1) q
 UNION SELECT reviewed_by FROM roster UNION SELECT reviewed_by FROM authorities UNION SELECT user_id FROM authorities
 UNION SELECT b.user_id FROM atrium.resident_account_bindings b,c WHERE b.unit_id=c.unit_id AND b.revoked_at IS NULL)
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::text[]) FROM ids WHERE id IS NOT NULL
$$;
CREATE FUNCTION atrium.consent_self() RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE u record; s record; BEGIN
 IF atrium.context('actor_user_id') IS NULL OR NOT atrium.enrollment_uuid(to_jsonb(atrium.context('session_id'))) OR atrium.context('session_audience') NOT IN ('staff','resident') OR atrium.context('login_username') IS NOT NULL
 OR atrium.context('channel_provider') IS NOT NULL OR atrium.context('channel_external_id') IS NOT NULL OR atrium.context('channel_binding_id') IS NOT NULL OR atrium.context('channel_binding_version') IS NOT NULL THEN RETURN false; END IF;
 SELECT id,status,credential_version INTO u FROM atrium.users WHERE id=atrium.context('actor_user_id');
 SELECT id,revoked_at_ms,expires_at_ms INTO s FROM atrium.user_sessions WHERE id=atrium.context('session_id')::uuid AND user_id=u.id AND credential_version=u.credential_version AND audience=atrium.context('session_audience');
 RETURN FOUND AND u.status='active' AND u.credential_version::text=atrium.context('credential_version') AND s.revoked_at_ms IS NULL AND s.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000) AND atrium.mfa_login_allowed();
END $$;
CREATE FUNCTION atrium.consent_hold(cid uuid,proof uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE ids text[]; locked text; BEGIN
 ids:=atrium.consent_user_ids(cid);
 FOREACH locked IN ARRAY ids LOOP PERFORM id FROM atrium.users WHERE id=locked FOR SHARE; END LOOP;
 PERFORM id FROM atrium.user_sessions WHERE id::text=atrium.context('session_id') AND user_id=atrium.context('actor_user_id') FOR SHARE;
 IF NOT atrium.consent_self() THEN RAISE EXCEPTION 'consent_unauthenticated'; END IF;
 PERFORM user_id FROM atrium.mfa_states WHERE user_id=atrium.context('actor_user_id') FOR SHARE;
 IF proof IS NOT NULL AND NOT atrium.mfa_hold_proof(proof,'organization_administration') THEN RAISE EXCEPTION 'consent_forbidden'; END IF;
 PERFORM id FROM atrium.organizations WHERE id=atrium.context('organization_id') FOR SHARE;
 PERFORM id FROM atrium.properties WHERE organization_id=atrium.context('organization_id') AND id=atrium.context('property_id') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'consent_not_found'; END IF;
 IF ids IS DISTINCT FROM atrium.consent_user_ids(cid) THEN RAISE EXCEPTION 'consent_changed'; END IF;
 IF NOT atrium.consent_self() THEN RAISE EXCEPTION 'consent_unauthenticated'; END IF;
END $$;
CREATE FUNCTION atrium.consent_staff_current(permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT session_user='atrium_app' AND atrium.context('session_audience')='staff' AND atrium.service_staff_context() AND atrium.can_access_property(atrium.context('organization_id'),atrium.context('property_id'),permission)
$$;
CREATE FUNCTION atrium.consent_member_role(who text) RETURNS text LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT m.role FROM atrium.memberships m JOIN atrium.users u ON u.id=m.user_id WHERE u.id=who AND u.status='active' AND m.organization_id=atrium.context('organization_id') AND m.status='active'
 AND (m.access='organization' OR EXISTS(SELECT 1 FROM atrium.property_grants g WHERE g.membership_id=m.id AND g.organization_id=m.organization_id AND g.property_id=atrium.context('property_id') AND g.status='active'))
$$;
CREATE FUNCTION atrium.consent_roster_digest(unit text) RETURNS text LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT atrium.consent_hash(coalesce(jsonb_agg(jsonb_build_array(r.id,r.version,r.source_id) ORDER BY r.id),'[]'::jsonb)) FROM atrium.property_residents r
 JOIN atrium.resident_sources s ON s.organization_id=r.organization_id AND s.property_id=r.property_id AND s.id=r.source_id JOIN atrium.properties p ON p.organization_id=r.organization_id AND p.id=r.property_id
 WHERE r.unit_id=unit AND r.status='active' AND (s.ends_on IS NULL OR s.ends_on>(clock_timestamp() AT TIME ZONE p.time_zone)::date)
$$;
CREATE FUNCTION atrium.consent_policy_json(p atrium.consent_policies) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('organizationId',p.organization_id,'propertyId',p.property_id,'version',p.version,'enabled',p.enabled,'funding','property_no_resident_charge','recipientRule','reviewed_complete_roster','requireWorkConsent',p.require_work_consent,
 'noChargeStatement',p.no_charge_statement,'recipientProtocol',p.recipient_protocol,'entryProtocol',p.entry_protocol,'maximumResponseMinutes',p.maximum_response_minutes,'maximumConsentMinutes',p.maximum_consent_minutes,'maximumEntryMinutes',p.maximum_entry_minutes,
 'helpLabel',p.help_label,'helpPhone',p.help_phone,'helpUrl',p.help_url,'emergencyInstructions',p.emergency_instructions,'source',atrium.consent_source_json(p.source_reference,p.source_version,p.observed_at,p.valid_until),'publishedBy',p.published_by,'publishedAt',atrium.service_iso(p.published_at),
 'current',coalesce(p.enabled AND p.observed_at<=clock_timestamp() AND p.valid_until>clock_timestamp() AND atrium.consent_member_role(p.published_by)='owner',false))
$$;
CREATE FUNCTION atrium.consent_roster_json(p atrium.consent_rosters) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'organizationId',p.organization_id,'propertyId',p.property_id,'version',p.version,'unitId',p.unit_id,'policyVersion',p.policy_version,'residencyDigest',p.residency_digest,'complete',true,'protocolCompleted',true,
 'source',atrium.consent_source_json(p.source_reference,p.source_version,p.observed_at,p.valid_until),'reviewedBy',p.reviewed_by,'reviewedAt',atrium.service_iso(p.reviewed_at),
 'members',coalesce((SELECT jsonb_agg(jsonb_build_object('residentId',m.resident_id,'residentVersion',m.resident_version,'requiredPurposes',m.required_purposes) ORDER BY m.resident_id) FROM atrium.consent_roster_members m WHERE m.roster_id=p.id AND m.roster_version=p.version),'[]'::jsonb),
 'current',coalesce(p.observed_at<=clock_timestamp() AND p.valid_until>clock_timestamp() AND p.residency_digest=atrium.consent_roster_digest(p.unit_id) AND atrium.consent_member_role(p.reviewed_by) IN ('owner','admin'),false))
$$;
CREATE FUNCTION atrium.consent_authority_json(p atrium.consent_authorities) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'organizationId',p.organization_id,'propertyId',p.property_id,'version',p.version,'bindingId',p.binding_id,'bindingVersion',p.binding_version,'residentId',p.resident_id,'residentVersion',p.resident_version,'userId',p.user_id,'unitId',p.unit_id,'purpose',p.purpose,'policyVersion',p.policy_version,
 'source',atrium.consent_source_json(p.source_reference,p.source_version,p.observed_at,p.valid_until),'protocolCompleted',true,'reviewedBy',p.reviewed_by,'reviewedAt',atrium.service_iso(p.reviewed_at),'revokedAt',atrium.service_iso(p.revoked_at),
 'current',coalesce(p.revoked_at IS NULL AND p.observed_at<=clock_timestamp() AND p.valid_until>clock_timestamp() AND atrium.consent_member_role(p.reviewed_by) IN ('owner','admin'),false))
$$;
CREATE FUNCTION atrium.consent_request_json(q atrium.consent_requests) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',q.id,'organizationId',q.organization_id,'propertyId',q.property_id,'version',q.version,'caseId',q.case_id,'caseVersion',q.case_version,'planId',q.plan_id,'planVersion',q.plan_version,'configurationVersion',q.configuration_version,
 'maintenancePolicyVersion',q.maintenance_policy_version,'consentPolicyVersion',q.consent_policy_version,'rosterId',q.roster_id,'rosterVersion',q.roster_version,'purpose',q.purpose,'materialDigest',q.material_digest,'termsDigest',q.terms_digest,'terms',q.terms,
 'responseDeadline',atrium.service_iso(q.response_deadline),'consentValidUntil',atrium.service_iso(q.consent_valid_until),'publishedBy',q.published_by,'publishedAt',atrium.service_iso(q.published_at),'createdAt',atrium.service_iso(q.created_at),'withdrawnAt',atrium.service_iso(q.withdrawn_at))
$$;
CREATE FUNCTION atrium.consent_decision_json(d atrium.consent_decisions) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'requestId',d.request_id,'requestVersion',d.request_version,'purpose',d.purpose,'version',d.version,'actorUserId',d.actor_user_id,'decision',d.decision,'grantId',d.grant_id,'termsDigest',d.terms_digest,'decidedAt',atrium.service_iso(d.decided_at)) END
$$;

-- Financial admission is recomputed from typed records; no resident context is
-- impersonated as a staff actor and no historical approver session is required.
CREATE FUNCTION atrium.consent_plan_graph(cid uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE c atrium.service_cases%ROWTYPE; p atrium.maintenance_plans%ROWTYPE; pol atrium.maintenance_policies%ROWTYPE; cp atrium.consent_policies%ROWTYPE; v atrium.maintenance_vendors%ROWTYPE;
 r atrium.property_residents%ROWTYPE; s atrium.resident_sources%ROWTYPE; d atrium.maintenance_decisions%ROWTYPE; prop atrium.properties%ROWTYPE; cfg jsonb; holds text[]:='{}'; deadlines timestamptz[]:='{}'; words text; role_value text; automatic boolean; party jsonb; material jsonb;
BEGIN
 SELECT * INTO c FROM atrium.service_cases WHERE id=cid; IF NOT FOUND THEN RAISE EXCEPTION 'consent_not_found'; END IF;
 SELECT * INTO prop FROM atrium.properties WHERE organization_id=c.organization_id AND id=c.property_id;
 SELECT configuration INTO cfg FROM atrium.property_configurations WHERE organization_id=c.organization_id AND property_id=c.property_id AND version=prop.published_configuration_version AND status='published';
 SELECT * INTO p FROM atrium.maintenance_plans WHERE case_id=cid ORDER BY version DESC LIMIT 1;
 SELECT * INTO pol FROM atrium.maintenance_policies ORDER BY version DESC LIMIT 1;
 SELECT * INTO cp FROM atrium.consent_policies ORDER BY version DESC LIMIT 1;
 SELECT * INTO r FROM atrium.property_residents WHERE id=c.resident_id;
 SELECT * INTO s FROM atrium.resident_sources WHERE id=r.source_id;
 SELECT * INTO v FROM atrium.maintenance_vendors WHERE id=p.vendor_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO d FROM atrium.maintenance_decisions WHERE plan_id=p.id AND plan_version=p.version;
 words:=concat_ws(E'\n',c.summary,c.description,c.access_notes,p.scope_of_work,p.reason,d.reason);
 IF prop.status<>'active' OR NOT EXISTS(SELECT 1 FROM atrium.organizations WHERE id=c.organization_id AND status='active') OR cfg IS NULL THEN holds:=array_append(holds,'context_changed'); END IF;
 IF cp.version IS NULL OR NOT coalesce((atrium.consent_policy_json(cp)->>'current')::boolean,false) THEN holds:=array_append(holds,'unconfigured'); END IF;
 IF c.priority='emergency' OR c.state='emergency_review' OR cardinality(c.emergency_kinds)>0 OR cardinality(p.emergency_kinds)>0 OR cardinality(atrium.maintenance_emergencies(words))>0 THEN holds:=array_append(holds,'emergency'); END IF;
 IF p.id IS NULL THEN holds:=array_append(holds,'missing_plan'); ELSE
  IF p.withdrawn_at IS NOT NULL OR p.case_version<>c.version OR p.configuration_version IS DISTINCT FROM prop.published_configuration_version OR p.policy_version IS DISTINCT FROM pol.version OR p.resident_id IS DISTINCT FROM r.id OR p.resident_version IS DISTINCT FROM r.version THEN holds:=array_append(holds,'terms_changed'); END IF;
  IF c.state<>'ready_for_planning' OR c.location_kind='unknown' OR (c.location_kind='unit' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'inventory') unit WHERE unit->>'unitId'=c.unit_id))
   OR (c.location_kind='unit' AND c.request_origin<>'staff_observation' AND (r.id IS NULL OR r.unit_id<>c.unit_id OR atrium.resident_context_state(r)<>'current')) THEN holds:=array_append(holds,'context_changed'); END IF;
  IF pol.version IS NULL OR pol.observed_at>clock_timestamp() OR pol.valid_until<=clock_timestamp() OR atrium.consent_member_role(pol.published_by) IS DISTINCT FROM 'owner'
   OR cardinality(p.restrictions)>0 OR c.category=ANY(pol.excluded_categories) OR atrium.maintenance_restricted(words)
   OR p.maximum_cents IS NULL OR NOT p.includes_all_charges OR p.currency<>pol.currency OR p.maximum_cents>pol.owner_limit_cents
   OR (p.route='vendor' AND (v.id IS NULL OR v.version<>p.vendor_version OR v.status<>'approved' OR v.observed_at>clock_timestamp() OR v.valid_until<=clock_timestamp() OR NOT c.category=ANY(v.categories))) THEN holds:=array_append(holds,'spending_not_authorized'); END IF;
  automatic:=c.priority='routine' AND pol.automatic_limit_cents IS NOT NULL AND p.maximum_cents<=pol.automatic_limit_cents AND c.category=ANY(pol.automatic_categories) AND (p.route='internal' OR v.restrictions='');
  role_value:=atrium.consent_member_role(d.actor_user_id);
  IF d.decision='reject' OR (NOT coalesce(automatic,false) AND (d.id IS NULL OR d.decision<>'approve' OR role_value IS NULL OR role_value NOT IN ('admin','owner') OR (role_value='admin' AND (pol.manager_limit_cents IS NULL OR p.maximum_cents>pol.manager_limit_cents)) OR (pol.require_independent_approver AND d.actor_user_id=p.prepared_by))) THEN holds:=array_append(holds,'spending_not_authorized'); END IF;
 END IF;
 deadlines:=ARRAY[cp.valid_until,pol.valid_until]; IF p.route='vendor' THEN deadlines:=array_append(deadlines,v.valid_until); END IF;
 IF r.id IS NOT NULL THEN deadlines:=array_append(deadlines,s.valid_until); IF s.ends_on IS NOT NULL THEN deadlines:=array_append(deadlines,s.ends_on::timestamp AT TIME ZONE prop.time_zone); END IF; END IF;
 party:=CASE WHEN p.route='vendor' THEN jsonb_build_object('kind','vendor','id',v.id,'version',v.version,'name',v.name) ELSE jsonb_build_object('kind','internal','name',p.internal_team) END;
 material:=jsonb_build_object('caseId',c.id,'caseVersion',c.version,'planId',p.id,'planVersion',p.version,'configurationVersion',prop.published_configuration_version,'maintenancePolicyVersion',pol.version,'consentPolicyVersion',cp.version,'unitId',c.unit_id,'timeZone',prop.time_zone,'scopeOfWork',p.scope_of_work,'party',party,'funding','property_no_resident_charge','currency',p.currency,'maximumCents',p.maximum_cents,'accessRequirement',p.access_requirement,'residentId',p.resident_id,'residentVersion',p.resident_version);
 RETURN jsonb_build_object('caseVersion',c.version,'unitId',c.unit_id,'timeZone',prop.time_zone,'propertyName',prop.name,'configurationVersion',prop.published_configuration_version,'maintenancePolicyVersion',pol.version,
 'policy',CASE WHEN cp.version IS NULL THEN NULL ELSE atrium.consent_policy_json(cp) END,'help',CASE WHEN cp.version IS NULL THEN NULL ELSE jsonb_build_object('label',cp.help_label,'phone',cp.help_phone,'url',cp.help_url,'emergencyInstructions',cp.emergency_instructions) END,
 'plan',CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'version',p.version,'scopeOfWork',p.scope_of_work,'maximumCents',p.maximum_cents,'currency',p.currency,'accessRequirement',p.access_requirement,'party',party) END,
 'requiredWork',coalesce(cp.require_work_consent,false) OR coalesce(pol.require_resident_approval,true),'requiredEntry',coalesce(p.access_requirement='unit_entry',false),
 'materialDigest',atrium.consent_hash(material),'revision',atrium.consent_hash(jsonb_build_array(to_jsonb(p),to_jsonb(c),to_jsonb(pol),to_jsonb(cp),to_jsonb(v),to_jsonb(r),to_jsonb(s),to_jsonb(d),role_value,prop.permission_version,prop.published_configuration_version)),
 'holds',to_jsonb(holds),'deadlines',coalesce((SELECT jsonb_agg(atrium.service_iso(t)) FROM unnest(deadlines) t WHERE t IS NOT NULL),'[]'::jsonb));
END $$;
CREATE FUNCTION atrium.consent_roster_purpose(p atrium.consent_rosters,kind text) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('unitId',p.unit_id,'policyVersion',p.policy_version,'residencyDigest',p.residency_digest,'source',atrium.consent_source_json(p.source_reference,p.source_version,p.observed_at,p.valid_until),'reviewedBy',p.reviewed_by,
 'members',coalesce((SELECT jsonb_agg(jsonb_build_array(m.resident_id,m.resident_version) ORDER BY m.resident_id) FROM atrium.consent_roster_members m WHERE m.roster_id=p.id AND m.roster_version=p.version AND kind=ANY(m.required_purposes)),'[]'::jsonb))
$$;
CREATE FUNCTION atrium.consent_request_graph(q atrium.consent_requests) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE graph jsonb; holds jsonb; deadlines jsonb; members jsonb:='[]'; rr atrium.consent_rosters%ROWTYPE; latest atrium.consent_rosters%ROWTYPE;
 rec atrium.consent_recipients%ROWTYPE; a atrium.consent_authorities%ROWTYPE; b atrium.resident_account_bindings%ROWTYPE; d atrium.consent_decisions%ROWTYPE; r atrium.property_residents%ROWTYPE; s atrium.resident_sources%ROWTYPE; u record; f record; rh text[]; tz text; needed boolean; evidence jsonb:='[]'; ep atrium.resident_enrollment_policies%ROWTYPE; boundary timestamptz;
BEGIN
 graph:=atrium.consent_plan_graph(q.case_id); holds:=graph->'holds'; deadlines:=graph->'deadlines'; tz:=graph->>'timeZone';
 needed:=CASE WHEN q.purpose='work' THEN (graph->>'requiredWork')::boolean ELSE (graph->>'requiredEntry')::boolean END;
 IF q.material_digest IS DISTINCT FROM graph->>'materialDigest' THEN holds:=holds||'"terms_changed"'::jsonb; END IF;
 IF q.withdrawn_at IS NOT NULL OR EXISTS(SELECT 1 FROM atrium.consent_requests n WHERE n.id=q.id AND n.version>q.version) THEN holds:=holds||'"request_withdrawn"'::jsonb; END IF;
 SELECT * INTO rr FROM atrium.consent_rosters WHERE id=q.roster_id AND version=q.roster_version;
 SELECT * INTO latest FROM atrium.consent_rosters WHERE unit_id=rr.unit_id ORDER BY version DESC LIMIT 1;
 IF latest.id IS NULL OR NOT coalesce((atrium.consent_roster_json(latest)->>'current')::boolean,false) OR atrium.consent_roster_purpose(rr,q.purpose) IS DISTINCT FROM atrium.consent_roster_purpose(latest,q.purpose) THEN holds:=holds||'"roster_changed"'::jsonb; END IF;
 deadlines:=deadlines||jsonb_build_array(atrium.service_iso(rr.valid_until));
 -- A reviewed non-required household member ending occupancy changes completeness too.
 FOR boundary IN SELECT s.ends_on::timestamp AT TIME ZONE tz FROM atrium.consent_roster_members rm JOIN atrium.property_residents r ON r.id=rm.resident_id AND r.organization_id=rm.organization_id AND r.property_id=rm.property_id JOIN atrium.resident_sources s ON s.id=r.source_id AND s.organization_id=r.organization_id AND s.property_id=r.property_id WHERE rm.roster_id=rr.id AND rm.roster_version=rr.version AND s.ends_on IS NOT NULL LOOP deadlines:=deadlines||jsonb_build_array(atrium.service_iso(boundary)); END LOOP;
 FOR rec IN SELECT * FROM atrium.consent_recipients WHERE request_id=q.id AND request_version=q.version ORDER BY resident_id LOOP
  rh:='{}'; SELECT * INTO a FROM atrium.consent_authorities WHERE id=rec.authority_id ORDER BY version DESC LIMIT 1;
  SELECT * INTO b FROM atrium.resident_account_bindings WHERE id=rec.binding_id;
  SELECT * INTO r FROM atrium.property_residents WHERE id=rec.resident_id;
  SELECT * INTO s FROM atrium.resident_sources WHERE id=r.source_id;
  SELECT * INTO ep FROM atrium.resident_enrollment_policies WHERE version=b.policy_version;
  SELECT id,status,credential_version INTO u FROM atrium.users WHERE id=rec.user_id;
  SELECT * INTO d FROM atrium.consent_decisions WHERE request_id=q.id AND request_version=q.version AND actor_user_id=rec.user_id ORDER BY version DESC LIMIT 1;
  IF a.id IS NULL OR a.version<>rec.authority_version OR NOT coalesce((atrium.consent_authority_json(a)->>'current')::boolean,false) OR a.policy_version<>q.consent_policy_version THEN rh:=array_append(rh,'authority_changed'); END IF;
  IF b.id IS NULL OR b.version<>rec.binding_version OR b.resident_version<>rec.resident_version OR b.user_id<>rec.user_id OR b.revoked_at IS NOT NULL OR NOT atrium.enrollment_context_current(b.organization_id,b.property_id,b.resident_id,b.resident_version,b.source_id,b.policy_version,b.configuration_version) THEN rh:=array_append(rh,'binding_changed'); END IF;
  IF r.id IS NULL OR r.version<>rec.resident_version OR r.status<>'active' OR atrium.resident_context_state(r)<>'current' THEN rh:=array_append(rh,'context_changed'); END IF;
  IF u.id IS NULL OR u.status<>'active' OR (d.decision='grant' AND u.credential_version<>d.actor_credential_version) THEN rh:=array_append(rh,'account_changed'); END IF;
  IF d.decision='grant' THEN SELECT status INTO f FROM atrium.mfa_factors WHERE id=d.factor_id AND user_id=rec.user_id; IF NOT FOUND OR f.status<>'active' THEN rh:=array_append(rh,'factor_revoked'); END IF; END IF;
  deadlines:=deadlines||jsonb_build_array(atrium.service_iso(a.valid_until),atrium.service_iso(s.valid_until),atrium.service_iso(ep.valid_until));
  IF s.starts_on::timestamp AT TIME ZONE tz>clock_timestamp() THEN deadlines:=deadlines||jsonb_build_array(atrium.service_iso(s.starts_on::timestamp AT TIME ZONE tz)); END IF;
  IF s.ends_on IS NOT NULL THEN deadlines:=deadlines||jsonb_build_array(atrium.service_iso(s.ends_on::timestamp AT TIME ZONE tz)); END IF;
  members:=members||jsonb_build_array(jsonb_build_object('residentId',rec.resident_id,'residentVersion',rec.resident_version,'bindingId',rec.binding_id,'bindingVersion',rec.binding_version,'userId',rec.user_id,'authorityId',rec.authority_id,'authorityVersion',rec.authority_version,'purpose',rec.purpose,'displayName',s.display_name,'decision',atrium.consent_decision_json(d),'holds',to_jsonb(rh)));
  evidence:=evidence||jsonb_build_array(jsonb_build_array(to_jsonb(a),to_jsonb(b),r.version,r.source_id,to_jsonb(u),to_jsonb(d),CASE WHEN d.decision='grant' THEN (SELECT status FROM atrium.mfa_factors WHERE id=d.factor_id) ELSE NULL END));
 END LOOP;
 RETURN jsonb_build_object('required',coalesce(needed,true),'request',atrium.consent_request_json(q),'holds',holds,'recipients',members,'deadlines',deadlines,'help',graph->'help','revision',atrium.consent_hash(jsonb_build_array(graph->'revision',to_jsonb(q),to_jsonb(rr),to_jsonb(latest),evidence)));
END $$;
CREATE FUNCTION atrium.consent_admissible(q atrium.consent_requests,actor text,granting boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE g jsonb; BEGIN
 g:=atrium.consent_request_graph(q);
 RETURN coalesce((g->>'required')::boolean AND jsonb_array_length(g->'holds')=0 AND q.withdrawn_at IS NULL AND q.consent_valid_until>clock_timestamp()
 AND (NOT granting OR q.response_deadline>clock_timestamp()) AND jsonb_array_length(g->'recipients')>0
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g->'recipients') r WHERE jsonb_array_length(r->'holds')>0)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(g->'recipients') r WHERE r->>'userId'=actor)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(g->'deadlines') t WHERE t IS NULL OR t::timestamptz<=clock_timestamp())
 AND (q.purpose<>'entry' OR (q.terms->'entryWindow'<>'null'::jsonb AND (q.terms#>>'{entryWindow,endsAt}')::timestamptz>clock_timestamp())),false);
END $$;
CREATE FUNCTION atrium.consent_history(rid uuid,who text,input jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE rows jsonb; count_limit integer:=(input->>'limit')::integer; BEGIN
 IF count_limit NOT BETWEEN 1 AND 50 OR (input ? 'before' AND (NOT atrium.enrollment_uuid(input#>'{before,id}') OR NOT atrium.enrollment_time(input#>'{before,createdAt}'))) THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
 WITH history AS (
  SELECT q.history_id id,q.published_at created_at,q.id request_id,q.version request_version,q.purpose,CASE WHEN q.withdrawn_at IS NULL THEN 'published' ELSE 'withdrawn' END kind,NULL::jsonb decision,q.terms_digest,q.terms
  FROM atrium.consent_requests q WHERE q.id=rid AND (who IS NULL OR EXISTS(SELECT 1 FROM atrium.consent_decisions d WHERE d.request_id=q.id AND d.request_version=q.version AND d.actor_user_id=who))
  UNION ALL SELECT d.id,d.decided_at,d.request_id,d.request_version,d.purpose,d.decision,atrium.consent_decision_json(d),d.terms_digest,q.terms
  FROM atrium.consent_decisions d JOIN atrium.consent_requests q ON q.id=d.request_id AND q.version=d.request_version AND q.organization_id=d.organization_id AND q.property_id=d.property_id WHERE d.request_id=rid AND (who IS NULL OR d.actor_user_id=who)
 ), page AS (SELECT * FROM history WHERE NOT(input ? 'before') OR (created_at,id)<((input#>>'{before,createdAt}')::timestamptz,(input#>>'{before,id}')::uuid) ORDER BY created_at DESC,id DESC LIMIT count_limit+1)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'requestId',request_id,'requestVersion',request_version,'purpose',purpose,'kind',kind,'createdAt',atrium.service_iso(created_at),'decision',decision,'termsDigest',terms_digest,'terms',terms) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO rows FROM page;
 RETURN jsonb_build_object('rows',rows);
END $$;
CREATE FUNCTION atrium.consent_receipt_save(input jsonb,cid uuid,res text,rid text,ver bigint,q atrium.consent_requests) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE result jsonb; stamp timestamptz(3):=clock_timestamp(); BEGIN
 result:=jsonb_build_object('commandId',input->>'commandId','action',input->>'action','resource',res,'id',rid,'version',ver,'requestId',q.id,'requestVersion',q.version,'purpose',q.purpose,'actorUserId',atrium.context('actor_user_id'),'committedAt',atrium.service_iso(stamp),'replayed',false,'outcome','saved');
 INSERT INTO atrium.consent_commands(organization_id,property_id,case_id,actor_user_id,actor_credential_version,actor_session_id,command_id,manifest,receipt,committed_at)
 VALUES(atrium.context('organization_id'),atrium.context('property_id'),cid,atrium.context('actor_user_id'),atrium.context('credential_version')::bigint,atrium.context('session_id')::uuid,(input->>'commandId')::uuid,input,result,stamp);
 RETURN result;
END $$;
CREATE FUNCTION atrium.consent_staff(mode text,input jsonb,configuration_version bigint,proof uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE org text:=atrium.context('organization_id'); prop text:=atrium.context('property_id'); actor text:=atrium.context('actor_user_id'); cid uuid; command jsonb; action text; details jsonb; src jsonb; graph jsonb; result jsonb; prior atrium.consent_commands%ROWTYPE;
 pol atrium.consent_policies%ROWTYPE; roster atrium.consent_rosters%ROWTYPE; old_roster atrium.consent_rosters%ROWTYPE; authority atrium.consent_authorities%ROWTYPE; old_authority atrium.consent_authorities%ROWTYPE; binding atrium.resident_account_bindings%ROWTYPE; selected_unit text;
 q atrium.consent_requests%ROWTYPE; old_q atrium.consent_requests%ROWTYPE; empty_q atrium.consent_requests%ROWTYPE; member jsonb; residents jsonb; entries jsonb; purposes jsonb:='[]'; kind text; terms jsonb; recipients jsonb; current_members jsonb; requested_members jsonb; permission text:='operate'; stamp timestamptz(3); expected bigint;
BEGIN
 IF session_user<>'atrium_app' OR NOT atrium.consent_staff_current('operate') OR NOT atrium.enrollment_uuid(input->'caseId') OR mode NOT IN ('state','history','receipt','execute') THEN RAISE EXCEPTION 'consent_forbidden'; END IF;
 cid:=(input->>'caseId')::uuid; command:=input->'command'; action:=command->>'action';
 IF mode='execute' THEN
  IF NOT atrium.enrollment_uuid(command->'commandId') OR jsonb_typeof(command)<>'object' OR pg_column_size(command)>32768 OR NOT atrium.service_text(command->'reason',3,1000,false) THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
  IF action NOT IN ('publish_policy','publish_roster','save_authority','revoke_authority','publish_request','withdraw_request') THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
  IF action NOT IN ('publish_request','withdraw_request') THEN permission:='configure'; IF proof IS NULL THEN RAISE EXCEPTION 'consent_forbidden'; END IF; END IF;
 END IF;
 PERFORM atrium.consent_hold(cid,CASE WHEN permission='configure' THEN proof ELSE NULL END);
 IF NOT atrium.consent_staff_current(permission) OR NOT EXISTS(SELECT 1 FROM atrium.properties WHERE id=prop AND organization_id=org AND published_configuration_version=configuration_version) THEN RAISE EXCEPTION 'consent_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM atrium.service_cases WHERE id=cid) THEN RAISE EXCEPTION 'consent_not_found'; END IF;
 SELECT unit_id INTO selected_unit FROM atrium.service_cases WHERE id=cid;
 IF mode='receipt' THEN
  SELECT * INTO prior FROM atrium.consent_commands WHERE actor_user_id=actor AND command_id=(input->>'commandId')::uuid AND case_id=cid AND organization_id=org AND property_id=prop;
  result:=CASE WHEN prior.actor_credential_version IS NOT DISTINCT FROM atrium.context('credential_version')::bigint THEN prior.receipt||'{"replayed":true}'::jsonb ELSE NULL END;
 ELSIF mode='history' THEN
  IF NOT EXISTS(SELECT 1 FROM atrium.consent_requests WHERE id=(input->>'requestId')::uuid AND case_id=cid) THEN RAISE EXCEPTION 'consent_not_found'; END IF;
  result:=atrium.consent_history((input->>'requestId')::uuid,NULL,input->'query');
 ELSIF mode='state' THEN
  graph:=atrium.consent_plan_graph(cid); SELECT * INTO pol FROM atrium.consent_policies ORDER BY version DESC LIMIT 1;
  SELECT * INTO roster FROM atrium.consent_rosters WHERE unit_id=graph->>'unitId' ORDER BY version DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'version',r.version,'displayName',s.display_name,'unitId',r.unit_id,'contextState',atrium.resident_context_state(r),'bindingId',b.id,'bindingVersion',b.version) ORDER BY r.id),'[]') INTO residents
  FROM atrium.property_residents r JOIN atrium.resident_sources s ON s.id=r.source_id AND s.organization_id=r.organization_id AND s.property_id=r.property_id
  LEFT JOIN atrium.resident_account_bindings b ON b.resident_id=r.id AND b.organization_id=r.organization_id AND b.property_id=r.property_id AND b.revoked_at IS NULL
  WHERE r.unit_id=graph->>'unitId' AND r.status='active' AND (s.ends_on IS NULL OR s.ends_on>(clock_timestamp() AT TIME ZONE (graph->>'timeZone'))::date);
  SELECT coalesce(jsonb_agg(atrium.consent_authority_json(a) ORDER BY a.id),'[]') INTO entries FROM (SELECT DISTINCT ON(id) * FROM atrium.consent_authorities WHERE unit_id=graph->>'unitId' ORDER BY id,version DESC) a;
  FOREACH kind IN ARRAY ARRAY['work','entry'] LOOP
   SELECT * INTO q FROM atrium.consent_requests WHERE case_id=cid AND purpose=kind ORDER BY version DESC LIMIT 1;
   purposes:=purposes||jsonb_build_array(jsonb_build_object('purpose',kind,'graph',CASE WHEN q.id IS NULL THEN jsonb_build_object('required',CASE WHEN kind='work' THEN graph->'requiredWork' ELSE graph->'requiredEntry' END,'request',NULL,'recipients','[]'::jsonb,'holds',graph->'holds','deadlines',graph->'deadlines') ELSE atrium.consent_request_graph(q) END));
  END LOOP;
  result:=jsonb_build_object('organizationId',org,'propertyId',prop,'configurationVersion',configuration_version,'caseId',cid,'caseVersion',graph->'caseVersion','unitId',graph->'unitId','timeZone',graph->'timeZone','policy',graph->'policy','roster',CASE WHEN roster.id IS NULL THEN NULL ELSE atrium.consent_roster_json(roster) END,'authorities',entries,'residents',residents,'plan',graph->'plan','purposes',purposes,'canPublishPolicy',atrium.consent_member_role(actor)='owner','canManageAuthority',atrium.consent_staff_current('configure'),'canPublishRequest',true,'help',graph->'help');
 ELSE
  SELECT * INTO prior FROM atrium.consent_commands WHERE actor_user_id=actor AND command_id=(command->>'commandId')::uuid;
  IF FOUND THEN
   IF prior.manifest IS DISTINCT FROM command OR prior.organization_id<>org OR prior.property_id<>prop OR prior.case_id<>cid OR prior.actor_credential_version::text<>atrium.context('credential_version') THEN RAISE EXCEPTION 'consent_request_conflict'; END IF;
   result:=prior.receipt||'{"replayed":true}'::jsonb;
  ELSE
   details:=command->'details'; src:=details->'source'; expected:=(command->>'expectedVersion')::bigint; stamp:=clock_timestamp();
   SELECT * INTO pol FROM atrium.consent_policies ORDER BY version DESC LIMIT 1;
   IF action='publish_policy' THEN
    IF atrium.consent_member_role(actor) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'consent_forbidden'; END IF;
    IF expected<>coalesce(pol.version,0) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    IF jsonb_typeof(details->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(details->'requireWorkConsent') IS DISTINCT FROM 'boolean' OR details->>'funding' IS DISTINCT FROM 'property_no_resident_charge' OR details->>'recipientRule' IS DISTINCT FROM 'reviewed_complete_roster'
     OR ((details->>'enabled')::boolean AND NOT coalesce(atrium.consent_source_valid(src),false)) THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
    INSERT INTO atrium.consent_policies VALUES(org,prop,expected+1,(details->>'enabled')::boolean,(details->>'requireWorkConsent')::boolean,details->>'noChargeStatement',details->>'recipientProtocol',details->>'entryProtocol',(details->>'maximumResponseMinutes')::integer,(details->>'maximumConsentMinutes')::integer,(details->>'maximumEntryMinutes')::integer,details->>'helpLabel',details->>'helpPhone',details->>'helpUrl',details->>'emergencyInstructions',src->>'reference',src->>'version',(src->>'observedAt')::timestamptz,(src->>'validUntil')::timestamptz,actor,stamp) RETURNING * INTO pol;
    result:=atrium.consent_receipt_save(command,cid,'policy',prop,pol.version,empty_q);
   ELSIF action='publish_roster' THEN
    IF selected_unit IS NULL OR selected_unit IS DISTINCT FROM details->>'unitId' THEN RAISE EXCEPTION 'consent_changed'; END IF;
    IF pol.version IS DISTINCT FROM (command->>'policyVersion')::bigint OR NOT coalesce((atrium.consent_policy_json(pol)->>'current')::boolean,false) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    IF details->'complete' IS DISTINCT FROM 'true'::jsonb OR details->'protocolCompleted' IS DISTINCT FROM 'true'::jsonb OR NOT coalesce(atrium.consent_source_valid(src),false) OR jsonb_typeof(details->'members') IS DISTINCT FROM 'array' OR jsonb_array_length(details->'members')>50 THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
    SELECT * INTO old_roster FROM atrium.consent_rosters WHERE unit_id=details->>'unitId' ORDER BY version DESC LIMIT 1;
    IF expected<>coalesce(old_roster.version,0) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_array(r.id,r.version) ORDER BY r.id),'[]') INTO current_members FROM atrium.property_residents r JOIN atrium.resident_sources s ON s.id=r.source_id AND s.organization_id=r.organization_id AND s.property_id=r.property_id JOIN atrium.properties p ON p.id=r.property_id AND p.organization_id=r.organization_id
     WHERE r.unit_id=details->>'unitId' AND r.status='active' AND (s.ends_on IS NULL OR s.ends_on>(clock_timestamp() AT TIME ZONE p.time_zone)::date);
    SELECT coalesce(jsonb_agg(jsonb_build_array(m->'residentId',m->'residentVersion') ORDER BY m->>'residentId'),'[]') INTO requested_members FROM jsonb_array_elements(details->'members') m;
    IF current_members IS DISTINCT FROM requested_members OR NOT EXISTS(SELECT 1 FROM atrium.properties p JOIN atrium.property_configurations cfg ON cfg.property_id=p.id AND cfg.organization_id=p.organization_id AND cfg.version=p.published_configuration_version WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(cfg.configuration->'inventory') u WHERE u->>'unitId'=details->>'unitId')) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    INSERT INTO atrium.consent_rosters VALUES(org,prop,coalesce(old_roster.id,gen_random_uuid()),expected+1,details->>'unitId',pol.version,atrium.consent_roster_digest(details->>'unitId'),src->>'reference',src->>'version',(src->>'observedAt')::timestamptz,(src->>'validUntil')::timestamptz,actor,stamp) RETURNING * INTO roster;
    FOR member IN SELECT * FROM jsonb_array_elements(details->'members') LOOP
     IF NOT atrium.enrollment_uuid(member->'residentId') OR NOT atrium.enrollment_version(member->'residentVersion') OR jsonb_typeof(member->'requiredPurposes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
     INSERT INTO atrium.consent_roster_members VALUES(org,prop,roster.id,roster.version,(member->>'residentId')::uuid,(member->>'residentVersion')::bigint,ARRAY(SELECT jsonb_array_elements_text(member->'requiredPurposes')));
    END LOOP;
    result:=atrium.consent_receipt_save(command,cid,'roster',roster.id::text,roster.version,empty_q);
   ELSIF action IN ('save_authority','revoke_authority') THEN
    SELECT * INTO old_authority FROM atrium.consent_authorities WHERE id=(command->>'id')::uuid ORDER BY version DESC LIMIT 1;
    IF selected_unit IS NULL OR (old_authority.id IS NOT NULL AND old_authority.unit_id IS DISTINCT FROM selected_unit) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    IF expected<>coalesce(old_authority.version,0) OR (action='revoke_authority' AND old_authority.id IS NULL) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    IF action='revoke_authority' THEN authority:=old_authority; authority.version:=expected+1; authority.revoked_at:=stamp; authority.reviewed_by:=actor; authority.reviewed_at:=stamp;
    ELSE
     IF pol.version IS DISTINCT FROM (command->>'policyVersion')::bigint OR NOT coalesce((atrium.consent_policy_json(pol)->>'current')::boolean,false) OR NOT coalesce(atrium.consent_source_valid(src),false) OR details->'protocolCompleted' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'consent_changed'; END IF;
     SELECT * INTO binding FROM atrium.resident_account_bindings WHERE id=(details->>'bindingId')::uuid;
     IF binding.id IS NULL OR binding.unit_id IS DISTINCT FROM selected_unit OR binding.version<>(details->>'bindingVersion')::bigint OR binding.resident_id IS DISTINCT FROM (details->>'residentId')::uuid OR binding.resident_version IS DISTINCT FROM (details->>'residentVersion')::bigint OR binding.revoked_at IS NOT NULL
      OR NOT atrium.enrollment_context_current(org,prop,binding.resident_id,binding.resident_version,binding.source_id,binding.policy_version,binding.configuration_version) THEN RAISE EXCEPTION 'consent_changed'; END IF;
     IF old_authority.id IS NOT NULL AND (old_authority.binding_id<>binding.id OR old_authority.purpose<>details->>'purpose') THEN RAISE EXCEPTION 'consent_changed'; END IF;
     authority.organization_id:=org;authority.property_id:=prop;authority.id:=coalesce(old_authority.id,gen_random_uuid());authority.version:=expected+1;authority.binding_id:=binding.id;authority.binding_version:=binding.version;authority.resident_id:=binding.resident_id;authority.resident_version:=binding.resident_version;authority.user_id:=binding.user_id;authority.unit_id:=binding.unit_id;authority.purpose:=details->>'purpose';authority.policy_version:=pol.version;
     authority.source_reference:=src->>'reference';authority.source_version:=src->>'version';authority.observed_at:=(src->>'observedAt')::timestamptz;authority.valid_until:=(src->>'validUntil')::timestamptz;authority.reviewed_by:=actor;authority.reviewed_at:=stamp;
    END IF;
    INSERT INTO atrium.consent_authorities SELECT authority.*;
    result:=atrium.consent_receipt_save(command,cid,'authority',authority.id::text,authority.version,empty_q);
   ELSIF action='withdraw_request' THEN
    SELECT * INTO old_q FROM atrium.consent_requests WHERE id=(command->>'requestId')::uuid AND case_id=cid ORDER BY version DESC LIMIT 1;
    IF old_q.id IS NULL OR old_q.version<>expected THEN RAISE EXCEPTION 'consent_changed'; END IF;
    q:=old_q;q.version:=expected+1;q.withdrawn_at:=stamp;q.published_at:=stamp;q.published_by:=actor;q.history_id:=gen_random_uuid();INSERT INTO atrium.consent_requests SELECT q.*;
    INSERT INTO atrium.consent_recipients SELECT organization_id,property_id,request_id,q.version,resident_id,resident_version,binding_id,binding_version,user_id,authority_id,authority_version,purpose FROM atrium.consent_recipients WHERE request_id=old_q.id AND request_version=old_q.version;
    result:=atrium.consent_receipt_save(command,cid,'request',q.id::text,q.version,q);
   ELSE
    IF command->>'caseId' IS DISTINCT FROM cid::text OR command->'reviewedAgainstPlan' IS DISTINCT FROM 'true'::jsonb OR command->>'funding' IS DISTINCT FROM 'property_no_resident_charge' THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
    graph:=atrium.consent_plan_graph(cid); kind:=command->>'purpose';
    IF kind NOT IN ('work','entry') OR graph->'plan'='null'::jsonb OR jsonb_array_length(graph->'holds')>0 OR (graph->>'caseVersion')::bigint<>(command->>'expectedCaseVersion')::bigint OR graph#>>'{plan,id}' IS DISTINCT FROM command->>'planId' OR (graph#>>'{plan,version}')::bigint<>(command->>'planVersion')::bigint OR pol.version<>(command->>'consentPolicyVersion')::bigint THEN RAISE EXCEPTION 'consent_changed'; END IF;
    IF NOT coalesce(CASE WHEN kind='work' THEN (graph->>'requiredWork')::boolean ELSE (graph->>'requiredEntry')::boolean END,false) THEN RAISE EXCEPTION 'consent_held'; END IF;
    SELECT * INTO old_q FROM atrium.consent_requests WHERE case_id=cid AND purpose=kind ORDER BY version DESC LIMIT 1;
    IF expected<>coalesce(old_q.version,0) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    SELECT * INTO roster FROM atrium.consent_rosters WHERE id=(command->>'rosterId')::uuid AND version=(command->>'rosterVersion')::bigint AND unit_id=graph->>'unitId';
    IF roster.id IS NULL OR roster.policy_version<>pol.version OR NOT coalesce((atrium.consent_roster_json(roster)->>'current')::boolean,false) OR EXISTS(SELECT 1 FROM atrium.consent_rosters n WHERE n.unit_id=roster.unit_id AND n.version>roster.version) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    IF NOT atrium.service_text(command->'publicSummary',10,1000,false) OR NOT atrium.service_text(command->'conditions',0,2000,true) OR NOT atrium.enrollment_time(command->'responseDeadline') OR NOT atrium.enrollment_time(command->'consentValidUntil') THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
    IF (command->>'responseDeadline')::timestamptz<=stamp OR (command->>'responseDeadline')::timestamptz>stamp+make_interval(mins=>pol.maximum_response_minutes) OR (command->>'consentValidUntil')::timestamptz>stamp+make_interval(mins=>pol.maximum_consent_minutes) OR (command->>'responseDeadline')::timestamptz>(command->>'consentValidUntil')::timestamptz THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
    IF kind='work' AND command->'entryWindow' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
    IF kind='entry' AND command->'entryWindow'<>'null'::jsonb THEN
     details:=command->'entryWindow';
     IF details->>'timeZone' IS DISTINCT FROM graph->>'timeZone' OR NOT atrium.enrollment_time(details->'startsAt') OR NOT atrium.enrollment_time(details->'endsAt') OR (details->>'endsAt')::timestamptz<=(details->>'startsAt')::timestamptz OR (details->>'endsAt')::timestamptz-(details->>'startsAt')::timestamptz>make_interval(mins=>pol.maximum_entry_minutes)
      OR (details->>'startsLocal')::timestamptz<>(details->>'startsAt')::timestamptz OR (details->>'endsLocal')::timestamptz<>(details->>'endsAt')::timestamptz
      OR to_char((details->>'startsAt')::timestamptz AT TIME ZONE (graph->>'timeZone'),'YYYY-MM-DD"T"HH24:MI:SS.MS')<>left(details->>'startsLocal',23) OR to_char((details->>'endsAt')::timestamptz AT TIME ZONE (graph->>'timeZone'),'YYYY-MM-DD"T"HH24:MI:SS.MS')<>left(details->>'endsLocal',23)
      OR (command->>'responseDeadline')::timestamptz>(details->>'startsAt')::timestamptz OR (command->>'consentValidUntil')::timestamptz<(details->>'endsAt')::timestamptz THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
    END IF;
    terms:=jsonb_build_object('schemaVersion',1,'purpose',kind,'propertyName',graph->'propertyName','unitId',graph->'unitId','publicSummary',command->'publicSummary','scopeOfWork',graph#>'{plan,scopeOfWork}','party',graph#>'{plan,party}','funding','property_no_resident_charge','currency','USD','propertyMaximumCents',graph#>'{plan,maximumCents}','residentChargeCents',0,'noChargeStatement',pol.no_charge_statement,'accessRequirement',graph#>'{plan,accessRequirement}','entryWindow',command->'entryWindow','conditions',command->'conditions');
    SELECT coalesce(jsonb_agg(jsonb_build_array(m.resident_id,m.resident_version,a.binding_id,a.binding_version,a.user_id,a.id,a.version) ORDER BY m.resident_id),'[]') INTO recipients FROM atrium.consent_roster_members m
     JOIN atrium.resident_account_bindings current_binding ON current_binding.resident_id=m.resident_id AND current_binding.organization_id=m.organization_id AND current_binding.property_id=m.property_id AND current_binding.revoked_at IS NULL
     JOIN LATERAL(SELECT * FROM atrium.consent_authorities a WHERE a.binding_id=current_binding.id AND a.purpose=kind ORDER BY version DESC LIMIT 1) a ON true WHERE m.roster_id=roster.id AND m.roster_version=roster.version AND kind=ANY(m.required_purposes);
    IF jsonb_array_length(recipients)=0 OR jsonb_array_length(recipients)<>(SELECT count(*) FROM atrium.consent_roster_members WHERE roster_id=roster.id AND roster_version=roster.version AND kind=ANY(required_purposes)) THEN RAISE EXCEPTION 'consent_held'; END IF;
    q.organization_id:=org;q.property_id:=prop;q.id:=coalesce(old_q.id,gen_random_uuid());q.version:=expected+1;q.case_id:=cid;q.purpose:=kind;q.case_version:=(graph->>'caseVersion')::bigint;q.plan_id:=(command->>'planId')::uuid;q.plan_version:=(command->>'planVersion')::bigint;q.configuration_version:=configuration_version;q.maintenance_policy_version:=(graph->>'maintenancePolicyVersion')::bigint;q.consent_policy_version:=pol.version;q.roster_id:=roster.id;q.roster_version:=roster.version;
    q.material_digest:=graph->>'materialDigest';q.terms_digest:=atrium.consent_hash(jsonb_build_object('materialDigest',q.material_digest,'terms',terms,'recipients',recipients,'roster',atrium.consent_roster_purpose(roster,kind)));q.terms:=terms;q.response_deadline:=(command->>'responseDeadline')::timestamptz;q.consent_valid_until:=(command->>'consentValidUntil')::timestamptz;q.published_by:=actor;q.published_at:=stamp;q.created_at:=coalesce(old_q.created_at,stamp);q.history_id:=gen_random_uuid();
    INSERT INTO atrium.consent_requests SELECT q.*;
    FOR member IN SELECT * FROM jsonb_array_elements(recipients) LOOP INSERT INTO atrium.consent_recipients VALUES(org,prop,q.id,q.version,(member->>0)::uuid,(member->>1)::bigint,(member->>2)::uuid,(member->>3)::bigint,member->>4,(member->>5)::uuid,(member->>6)::bigint,kind); END LOOP;
    graph:=atrium.consent_request_graph(q);
    IF jsonb_array_length(graph->'holds')>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(graph->'recipients') r WHERE jsonb_array_length(r->'holds')>0) THEN RAISE EXCEPTION 'consent_held'; END IF;
    result:=atrium.consent_receipt_save(command,cid,'request',q.id::text,q.version,q);
   END IF;
   -- Recheck evidence after inserts/audit waits. Exact saved receipts above do not renew evidence.
   IF action IN ('publish_roster','save_authority') OR (action='publish_policy' AND pol.enabled) THEN IF NOT coalesce(atrium.consent_source_valid(src),false) THEN RAISE EXCEPTION 'consent_changed'; END IF; END IF;
   IF action='publish_request' THEN graph:=atrium.consent_request_graph(q); IF jsonb_array_length(graph->'holds')>0 OR q.response_deadline<=clock_timestamp() OR EXISTS(SELECT 1 FROM jsonb_array_elements(graph->'recipients') r WHERE jsonb_array_length(r->'holds')>0) THEN RAISE EXCEPTION 'consent_changed'; END IF; END IF;
  END IF;
 END IF;
 IF NOT atrium.consent_self() OR NOT atrium.consent_staff_current(permission) OR (permission='configure' AND NOT atrium.mfa_hold_proof(proof,'organization_administration')) THEN RAISE EXCEPTION 'consent_forbidden'; END IF;
 RETURN jsonb_build_object('data',result,'evaluatedAt',atrium.service_iso(clock_timestamp()));
END $$;
CREATE FUNCTION atrium.consent_own_detail(q atrium.consent_requests) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE g jsonb; d atrium.consent_decisions%ROWTYPE; current_terms boolean; eligible boolean; BEGIN
 SELECT * INTO d FROM atrium.consent_decisions WHERE request_id=q.id AND request_version=q.version AND actor_user_id=atrium.context('actor_user_id') ORDER BY version DESC LIMIT 1;
 g:=atrium.consent_request_graph(q);current_terms:=atrium.consent_admissible(q,atrium.context('actor_user_id'),false);eligible:=current_terms AND q.response_deadline>clock_timestamp();
 -- Stale newly published terms are never disclosed merely because a locator is known.
 -- The account's already committed terms/decisions remain independently recoverable.
 IF NOT current_terms AND d.id IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('requestId',q.id,'requestVersion',q.version,'purpose',q.purpose,'termsDigest',q.terms_digest,'materialDigest',q.material_digest,'terms',q.terms,'responseDeadline',atrium.service_iso(q.response_deadline),'consentValidUntil',atrium.service_iso(q.consent_valid_until),'publishedAt',atrium.service_iso(q.published_at),'withdrawnAt',atrium.service_iso(q.withdrawn_at),
 'ownDecision',atrium.consent_decision_json(d),'ownDecisionVersion',coalesce(d.version,0),'effectiveness',atrium.consent_effectiveness(g),'canGrant',eligible,'canDecline',true,'canRevoke',d.decision='grant','requiresPasskey',true,'currentTerms',current_terms,'help',g->'help');
END $$;
CREATE FUNCTION atrium.consent_charge() RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE times timestamptz[]; stamp timestamptz:=clock_timestamp(); acquired boolean; BEGIN
 INSERT INTO atrium.consent_budgets(user_id,attempts,last_reserved_at) VALUES(atrium.context('actor_user_id'),'{}',stamp) ON CONFLICT DO NOTHING;
 SELECT attempts INTO times FROM atrium.consent_budgets WHERE user_id=atrium.context('actor_user_id') FOR UPDATE;
 -- A concurrent bounded cleanup may delete an expired conflicting row before the lock.
 IF NOT FOUND THEN INSERT INTO atrium.consent_budgets(user_id,attempts,last_reserved_at) VALUES(atrium.context('actor_user_id'),'{}',stamp) ON CONFLICT(user_id) DO UPDATE SET user_id=excluded.user_id RETURNING attempts INTO times; END IF;
 SELECT coalesce(array_agg(t ORDER BY t),'{}') INTO times FROM unnest(times) t WHERE t>stamp-interval '15 minutes'; acquired:=cardinality(times)<60;
 IF acquired THEN UPDATE atrium.consent_budgets SET attempts=array_append(times,stamp),last_reserved_at=stamp WHERE user_id=atrium.context('actor_user_id'); END IF;
 DELETE FROM atrium.consent_budgets b USING(SELECT user_id FROM atrium.consent_budgets WHERE last_reserved_at<=stamp-interval '15 minutes' AND user_id<>atrium.context('actor_user_id') ORDER BY last_reserved_at,user_id LIMIT 32 FOR UPDATE SKIP LOCKED) old WHERE b.user_id=old.user_id;
 -- Keep consumed ceremony evidence alongside immutable receipts. Expired unused challenges are bounded cleanup.
 DELETE FROM atrium.consent_ceremonies c USING(SELECT id FROM atrium.consent_ceremonies WHERE user_id=atrium.context('actor_user_id') AND expires_at<=stamp AND consumed_at IS NULL AND attempt_id IS NULL ORDER BY expires_at,id LIMIT 32 FOR UPDATE SKIP LOCKED) old WHERE c.id=old.id;
 RETURN acquired;
END $$;
CREATE FUNCTION atrium.consent_record_decision(command jsonb,q atrium.consent_requests,claim jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE prior atrium.consent_decisions%ROWTYPE; d atrium.consent_decisions%ROWTYPE; result jsonb; BEGIN
 SELECT * INTO prior FROM atrium.consent_decisions WHERE request_id=q.id AND request_version=q.version AND actor_user_id=atrium.context('actor_user_id') ORDER BY version DESC LIMIT 1;
 IF NOT atrium.enrollment_uuid(command->'commandId') OR jsonb_typeof(command->'expectedDecisionVersion') IS DISTINCT FROM 'number' OR (command->>'expectedDecisionVersion')::bigint<>coalesce(prior.version,0)
 OR q.version IS DISTINCT FROM (command->>'requestVersion')::bigint OR q.id::text IS DISTINCT FROM command->>'requestId' OR q.purpose IS DISTINCT FROM command->>'purpose' THEN RAISE EXCEPTION 'consent_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM atrium.consent_recipients WHERE request_id=q.id AND request_version=q.version AND user_id=atrium.context('actor_user_id')) THEN RAISE EXCEPTION 'consent_not_found'; END IF;
 IF command->>'action'='revoke' THEN IF prior.decision IS DISTINCT FROM 'grant' OR prior.id::text IS DISTINCT FROM command->>'grantId' THEN RAISE EXCEPTION 'consent_changed'; END IF;
 ELSIF q.terms_digest IS DISTINCT FROM command->>'termsDigest' THEN RAISE EXCEPTION 'consent_changed'; END IF;
 d.organization_id:=q.organization_id;d.property_id:=q.property_id;d.id:=gen_random_uuid();d.request_id:=q.id;d.request_version:=q.version;d.purpose:=q.purpose;d.actor_user_id:=atrium.context('actor_user_id');d.actor_credential_version:=atrium.context('credential_version')::bigint;d.actor_session_id:=atrium.context('session_id')::uuid;d.version:=coalesce(prior.version,0)+1;d.decision:=command->>'action';d.terms_digest:=q.terms_digest;d.command_id:=(command->>'commandId')::uuid;d.decided_at:=clock_timestamp();
 IF d.decision='grant' THEN d.grant_id:=d.id;d.factor_id:=(claim#>>'{factor,id}')::uuid;d.factor_counter_revision:=(claim#>>'{factor,counterRevision}')::bigint;d.security_version:=(claim->>'securityVersion')::bigint;
 ELSIF d.decision='revoke' THEN d.grant_id:=prior.id; END IF;
 INSERT INTO atrium.consent_decisions SELECT d.*;
 result:=atrium.consent_receipt_save(command,q.case_id,'decision',d.id::text,d.version,q);
 RETURN result;
END $$;
CREATE FUNCTION atrium.consent_resident(mode text,input jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE actor text:=atrium.context('actor_user_id'); q atrium.consent_requests%ROWTYPE; current_q atrium.consent_requests%ROWTYPE; prior atrium.consent_commands%ROWTYPE; c atrium.consent_ceremonies%ROWTYPE; m atrium.mfa_states%ROWTYPE; f atrium.mfa_factors%ROWTYPE;
 command jsonb; claim jsonb; result jsonb; before_result jsonb; rows jsonb:='[]'; ids uuid[]:='{}'; rid uuid; row jsonb; graph jsonb; previous_graph jsonb; stamp timestamptz(3); deadline timestamptz; version_value bigint; count_limit integer; factors jsonb;
BEGIN
 IF session_user<>'atrium_authenticator' OR atrium.context('session_audience') IS DISTINCT FROM 'resident' OR atrium.context('organization_id') IS NOT NULL OR atrium.context('property_id') IS NOT NULL OR jsonb_typeof(input) IS DISTINCT FROM 'object'
 OR mode NOT IN ('list','detail','history','receipt','begin','claim','finish','reject','decide') THEN RAISE EXCEPTION 'consent_forbidden'; END IF;
 IF NOT atrium.consent_self() THEN RAISE EXCEPTION 'consent_unauthenticated'; END IF;
 IF mode='list' THEN
  count_limit:=(input->>'limit')::integer; IF count_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
  -- Stable immutable request ordering. Scan until a full visible page or the actual end,
  -- not an arbitrary candidate prefix. SQL timeout fails closed instead of hiding matches.
  FOR q IN SELECT DISTINCT ON(id) * FROM atrium.consent_requests WHERE EXISTS(SELECT 1 FROM atrium.consent_recipients r WHERE r.request_id=consent_requests.id AND r.request_version=consent_requests.version AND r.user_id=actor)
   ORDER BY id,version DESC LOOP ids:=array_append(ids,q.id); END LOOP;
  FOR q IN SELECT DISTINCT ON(created_at,id) * FROM atrium.consent_requests WHERE id=ANY(ids) AND (NOT(input ? 'before') OR (created_at,id)<((input#>>'{before,createdAt}')::timestamptz,(input#>>'{before,id}')::uuid)) ORDER BY created_at DESC,id DESC,version DESC LOOP
   PERFORM set_config('atrium.organization_id',q.organization_id,true),set_config('atrium.property_id',q.property_id,true);
   IF NOT EXISTS(SELECT 1 FROM atrium.consent_recipients WHERE request_id=q.id AND request_version=q.version AND user_id=actor) THEN CONTINUE; END IF;
   row:=atrium.consent_own_detail(q);
   IF row IS NULL THEN SELECT previous.* INTO current_q FROM atrium.consent_requests previous WHERE previous.id=q.id AND EXISTS(SELECT 1 FROM atrium.consent_decisions saved WHERE saved.request_id=previous.id AND saved.request_version=previous.version AND saved.actor_user_id=actor) ORDER BY version DESC LIMIT 1; IF current_q.id IS NOT NULL THEN row:=atrium.consent_own_detail(current_q); END IF; END IF;
   IF row IS NOT NULL THEN rows:=rows||jsonb_build_array(jsonb_build_object('detail',row,'createdAt',atrium.service_iso(q.created_at),'id',q.id)); END IF;
   EXIT WHEN jsonb_array_length(rows)>count_limit;
  END LOOP;
  -- Repeat selected projections after graph reads. Any intervening change refuses a mixed page.
  FOR row IN SELECT * FROM jsonb_array_elements(rows) LOOP
   SELECT * INTO q FROM atrium.consent_requests WHERE id=(row->>'id')::uuid AND version=(row#>>'{detail,requestVersion}')::bigint;
   PERFORM set_config('atrium.organization_id',q.organization_id,true),set_config('atrium.property_id',q.property_id,true);
   before_result:=row->'detail';result:=atrium.consent_own_detail(q);
   IF (result- 'effectiveness') IS DISTINCT FROM (before_result-'effectiveness') OR ((result->'effectiveness')-'evaluatedAt') IS DISTINCT FROM ((before_result->'effectiveness')-'evaluatedAt') THEN RAISE EXCEPTION 'consent_changed'; END IF;
  END LOOP;
  result:=jsonb_build_object('rows',rows);
 ELSIF mode='receipt' THEN
  SELECT * INTO prior FROM atrium.consent_commands WHERE actor_user_id=actor AND command_id=(input->>'commandId')::uuid;
  result:=CASE WHEN prior.actor_credential_version::text=atrium.context('credential_version') THEN prior.receipt||'{"replayed":true}'::jsonb ELSE NULL END;
 ELSE
  IF mode IN ('claim','finish','reject') THEN
   SELECT * INTO c FROM atrium.consent_ceremonies WHERE id=(input->>'challengeId')::uuid AND user_id=actor;
   IF NOT FOUND OR c.session_id::text IS DISTINCT FROM atrium.context('session_id') OR c.credential_version::text IS DISTINCT FROM atrium.context('credential_version') THEN RAISE EXCEPTION 'consent_ceremony_used'; END IF;
   SELECT * INTO q FROM atrium.consent_requests WHERE id=c.request_id AND version=c.request_version;
  ELSE
   command:=CASE WHEN mode IN ('begin','decide') THEN input->'command' ELSE input END;
   IF NOT atrium.enrollment_uuid(command->'requestId') THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
   SELECT * INTO q FROM atrium.consent_requests WHERE id=(command->>'requestId')::uuid AND (mode IN ('detail','history') OR version=(command->>'requestVersion')::bigint)
    AND EXISTS(SELECT 1 FROM atrium.consent_recipients r WHERE r.request_id=consent_requests.id AND r.request_version=consent_requests.version AND r.user_id=actor) ORDER BY version DESC LIMIT 1;
  END IF;
  IF q.id IS NULL THEN IF mode='detail' THEN RETURN jsonb_build_object('data',NULL,'evaluatedAt',atrium.service_iso(clock_timestamp())); END IF; RAISE EXCEPTION 'consent_not_found'; END IF;
  PERFORM set_config('atrium.organization_id',q.organization_id,true),set_config('atrium.property_id',q.property_id,true);
  PERFORM atrium.consent_hold(q.case_id,NULL);
  SELECT * INTO q FROM atrium.consent_requests WHERE id=q.id AND version=q.version;
  IF NOT EXISTS(SELECT 1 FROM atrium.consent_recipients WHERE request_id=q.id AND request_version=q.version AND user_id=actor) THEN RAISE EXCEPTION 'consent_not_found'; END IF;
  IF mode='detail' THEN result:=atrium.consent_own_detail(q);
   IF result IS NULL THEN SELECT previous.* INTO current_q FROM atrium.consent_requests previous WHERE previous.id=q.id AND EXISTS(SELECT 1 FROM atrium.consent_decisions saved WHERE saved.request_id=previous.id AND saved.request_version=previous.version AND saved.actor_user_id=actor) ORDER BY version DESC LIMIT 1; IF current_q.id IS NOT NULL THEN result:=atrium.consent_own_detail(current_q); END IF; END IF;
  ELSIF mode='history' THEN result:=atrium.consent_history(q.id,actor,input->'query');
  ELSIF mode='decide' THEN
   SELECT * INTO prior FROM atrium.consent_commands WHERE actor_user_id=actor AND command_id=(command->>'commandId')::uuid;
   IF FOUND THEN IF prior.manifest IS DISTINCT FROM command OR prior.actor_credential_version::text<>atrium.context('credential_version') THEN RAISE EXCEPTION 'consent_request_conflict'; END IF;result:=prior.receipt||'{"replayed":true}'::jsonb;
   ELSE IF command->>'action' NOT IN ('decline','revoke') THEN RAISE EXCEPTION 'consent_invalid_input'; END IF; result:=atrium.consent_record_decision(command,q,NULL); END IF;
  ELSIF mode='begin' THEN
   IF NOT atrium.consent_charge() THEN RETURN jsonb_build_object('error','consent_rate_limited'); END IF;
   IF command->>'action' IS DISTINCT FROM 'grant' OR NOT atrium.enrollment_uuid(command->'commandId') OR q.material_digest IS DISTINCT FROM command->>'materialDigest' OR q.terms_digest IS DISTINCT FROM command->>'termsDigest' OR q.purpose IS DISTINCT FROM command->>'purpose' OR NOT atrium.consent_admissible(q,actor,true) THEN RAISE EXCEPTION 'consent_held'; END IF;
   SELECT coalesce(max(version),0) INTO version_value FROM atrium.consent_decisions WHERE request_id=q.id AND request_version=q.version AND actor_user_id=actor;
   IF version_value IS DISTINCT FROM (command->>'expectedDecisionVersion')::bigint THEN RAISE EXCEPTION 'consent_changed'; END IF;
   IF EXISTS(SELECT 1 FROM atrium.consent_commands WHERE actor_user_id=actor AND command_id=(command->>'commandId')::uuid) THEN RAISE EXCEPTION 'consent_ceremony_used'; END IF;
   SELECT * INTO m FROM atrium.mfa_states WHERE user_id=actor;
   IF m.origin IS DISTINCT FROM input->>'origin' OR m.rp_id IS DISTINCT FROM input->>'rpId' OR NOT m.ever_enabled THEN RAISE EXCEPTION 'consent_passkey_required'; END IF;
   SELECT coalesce(jsonb_agg(atrium.mfa_factor_json(active_factor) ORDER BY active_factor.id),'[]') INTO factors FROM atrium.mfa_factors active_factor WHERE active_factor.user_id=actor AND active_factor.status='active' AND active_factor.rp_id=m.rp_id;
   IF jsonb_array_length(factors) NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'consent_passkey_required'; END IF;
   stamp:=clock_timestamp(); deadline:=least(stamp+interval '5 minutes',to_timestamp((input->>'expiresAt')::numeric/1000),q.response_deadline,q.consent_valid_until);
   IF deadline<=stamp OR NOT atrium.enrollment_uuid(input->'challengeId') OR NOT atrium.enrollment_digest(input->'challengeHash') THEN RAISE EXCEPTION 'consent_invalid_input'; END IF;
   INSERT INTO atrium.consent_ceremonies(id,organization_id,property_id,user_id,session_id,credential_version,security_version,request_id,request_version,command,challenge_hash,origin,rp_id,created_at,expires_at)
    VALUES((input->>'challengeId')::uuid,q.organization_id,q.property_id,actor,atrium.context('session_id')::uuid,atrium.context('credential_version')::bigint,m.security_version,q.id,q.version,command,input->>'challengeHash',m.origin,m.rp_id,stamp,deadline) RETURNING * INTO c;
   result:=jsonb_build_object('id',c.id,'organizationId',c.organization_id,'propertyId',c.property_id,'userId',actor,'sessionId',c.session_id,'credentialVersion',c.credential_version,'securityVersion',c.security_version,'origin',c.origin,'rpId',c.rp_id,'challengeHash',c.challenge_hash,'expiresAt',floor(extract(epoch FROM c.expires_at)*1000)::bigint,'userHandle',m.user_handle,'command',command,'factors',factors);
   IF NOT atrium.consent_admissible(q,actor,true) THEN RAISE EXCEPTION 'consent_changed'; END IF;
  ELSE
   SELECT * INTO c FROM atrium.consent_ceremonies WHERE id=c.id FOR UPDATE;
   SELECT * INTO m FROM atrium.mfa_states WHERE user_id=actor;
   IF mode='reject' THEN
    IF c.attempt_id::text IS DISTINCT FROM input#>>'{claim,attemptId}' OR c.claim IS DISTINCT FROM input->'claim' THEN RAISE EXCEPTION 'consent_ceremony_used'; END IF;
    IF c.consumed_at IS NULL THEN UPDATE atrium.consent_ceremonies SET consumed_at=clock_timestamp() WHERE id=c.id; END IF; result:='null';
   ELSE
    IF c.consumed_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR c.security_version<>m.security_version OR c.origin<>m.origin OR c.rp_id<>m.rp_id OR NOT atrium.consent_admissible(q,actor,true) THEN RAISE EXCEPTION 'consent_ceremony_used'; END IF;
    IF mode='claim' THEN
     IF c.attempt_id IS NOT NULL OR NOT atrium.enrollment_uuid(input->'attemptId') OR NOT atrium.enrollment_digest(input->'responseDigest') THEN RAISE EXCEPTION 'consent_ceremony_used'; END IF;
     SELECT * INTO f FROM atrium.mfa_factors WHERE user_id=actor AND credential_id=input->>'credentialId' AND rp_id=c.rp_id AND status='active';
     IF NOT FOUND THEN UPDATE atrium.consent_ceremonies SET consumed_at=clock_timestamp() WHERE id=c.id; RETURN jsonb_build_object('error','consent_passkey_required'); END IF;
     claim:=jsonb_build_object('id',c.id,'attemptId',input->'attemptId','responseDigest',input->'responseDigest','challengeHash',c.challenge_hash,'userId',actor,'sessionId',c.session_id,'credentialVersion',c.credential_version,'securityVersion',c.security_version,'origin',c.origin,'rpId',c.rp_id,'userHandle',m.user_handle,'expiresAt',floor(extract(epoch FROM c.expires_at)*1000)::bigint,'factor',atrium.mfa_factor_json(f),
      'audience','resident','organizationId',q.organization_id,'propertyId',q.property_id,'requestId',q.id,'requestVersion',q.version,'purpose',q.purpose,'termsDigest',q.terms_digest,'materialDigest',q.material_digest,'commandId',c.command->'commandId','expectedDecisionVersion',c.command->'expectedDecisionVersion');
     UPDATE atrium.consent_ceremonies SET attempt_id=(input->>'attemptId')::uuid,claim=claim WHERE id=c.id;result:=claim;
    ELSE
     claim:=input->'claim';
     IF c.claim IS DISTINCT FROM claim OR c.attempt_id IS NULL OR input->>'kind' IS DISTINCT FROM 'resident_consent' THEN RAISE EXCEPTION 'consent_ceremony_used'; END IF;
     SELECT * INTO f FROM atrium.mfa_factors WHERE id=(claim#>>'{factor,id}')::uuid AND user_id=actor FOR UPDATE;
     IF NOT FOUND OR f.status<>'active' OR f.counter_revision IS DISTINCT FROM (claim#>>'{factor,counterRevision}')::bigint OR f.counter IS DISTINCT FROM (claim#>>'{factor,counter}')::bigint OR f.public_key IS DISTINCT FROM claim#>>'{factor,publicKey}' OR f.backup_eligible IS DISTINCT FROM (claim#>>'{factor,backupEligible}')::boolean
      OR jsonb_typeof(input->'newCounter') IS DISTINCT FROM 'number' OR (input->>'newCounter')::bigint NOT BETWEEN 0 AND 4294967295 OR ((f.counter>0 OR (input->>'newCounter')::bigint>0) AND (input->>'newCounter')::bigint<=f.counter) OR jsonb_typeof(input->'backedUp') IS DISTINCT FROM 'boolean' OR ((input->>'backedUp')::boolean AND NOT f.backup_eligible) THEN RAISE EXCEPTION 'consent_changed'; END IF;
     UPDATE atrium.mfa_factors SET counter=(input->>'newCounter')::bigint,counter_revision=counter_revision+1,backed_up=(input->>'backedUp')::boolean,last_used_at_ms=greatest(created_at_ms,atrium.mfa_now()) WHERE id=f.id;
     result:=atrium.consent_record_decision(c.command,q,claim);
     UPDATE atrium.consent_ceremonies SET consumed_at=clock_timestamp() WHERE id=c.id;
     IF c.expires_at<=clock_timestamp() OR NOT atrium.consent_admissible(q,actor,true) THEN RAISE EXCEPTION 'consent_changed'; END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 IF NOT atrium.consent_self() THEN RAISE EXCEPTION 'consent_unauthenticated'; END IF;
 RETURN jsonb_build_object('data',result,'evaluatedAt',atrium.service_iso(clock_timestamp()));
END $$;
CREATE FUNCTION atrium.consent_planning(cases uuid[],configuration_version bigint) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cid uuid; q atrium.consent_requests%ROWTYPE; g jsonb; rg jsonb; eff jsonb; output jsonb:='[]'; purposes jsonb; revisions jsonb; kind text; refresh timestamptz; BEGIN
 IF session_user<>'atrium_app' OR NOT atrium.consent_staff_current('operate') OR cardinality(cases)>201 OR cardinality(cases)<1 OR array_position(cases,NULL) IS NOT NULL THEN RAISE EXCEPTION 'consent_forbidden'; END IF;
 IF NOT EXISTS(SELECT 1 FROM atrium.properties WHERE organization_id=atrium.context('organization_id') AND id=atrium.context('property_id') AND published_configuration_version=configuration_version) THEN RAISE EXCEPTION 'consent_changed'; END IF;
 FOREACH cid IN ARRAY cases LOOP
  g:=atrium.consent_plan_graph(cid);purposes:='[]';revisions:=jsonb_build_array(g->'revision');refresh:=NULL;
  FOREACH kind IN ARRAY ARRAY['work','entry'] LOOP
   SELECT * INTO q FROM atrium.consent_requests WHERE case_id=cid AND purpose=kind ORDER BY version DESC LIMIT 1;
   rg:=CASE WHEN q.id IS NULL THEN jsonb_build_object('required',CASE WHEN kind='work' THEN g->'requiredWork' ELSE g->'requiredEntry' END,'request',NULL,'holds',g->'holds','recipients','[]'::jsonb,'deadlines',g->'deadlines') ELSE atrium.consent_request_graph(q) END;
   eff:=atrium.consent_effectiveness(rg);refresh:=least(refresh,(eff->>'refreshAt')::timestamptz);revisions:=revisions||jsonb_build_array(rg->'revision',rg->'holds',eff-'evaluatedAt'-'refreshAt');
   purposes:=purposes||jsonb_build_array(jsonb_build_object('purpose',kind,'requestId',q.id,'requestVersion',q.version,'materialDigest',q.material_digest,'required',eff->'required','effective',eff->'effective','holds',eff->'holds','refreshAt',eff->'refreshAt'));
  END LOOP;
  output:=output||jsonb_build_array(jsonb_build_object('caseId',cid,'caseVersion',g->'caseVersion','planId',g#>'{plan,id}','planVersion',g#>'{plan,version}','configurationVersion',configuration_version,'materialDigest',CASE WHEN g->'plan'='null'::jsonb THEN NULL ELSE g->'materialDigest' END,'revision',atrium.consent_hash(revisions),'purposes',purposes,'refreshAt',atrium.service_iso(refresh)));
 END LOOP;
 IF NOT atrium.consent_self() OR NOT atrium.consent_staff_current('operate') THEN RAISE EXCEPTION 'consent_forbidden'; END IF;
 RETURN output;
END $$;
CREATE FUNCTION atrium.consent_preserve_ceremony() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN IF OLD.expires_at<=clock_timestamp() AND OLD.attempt_id IS NULL AND OLD.consumed_at IS NULL THEN RETURN OLD; END IF; RAISE EXCEPTION 'Consent ceremony evidence is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['attempt_id','claim','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['attempt_id','claim','consumed_at']) OR OLD.consumed_at IS NOT NULL
 OR (OLD.attempt_id IS NOT NULL AND (NEW.attempt_id,NEW.claim) IS DISTINCT FROM (OLD.attempt_id,OLD.claim)) THEN RAISE EXCEPTION 'Consent ceremony evidence is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER consent_ceremony_history BEFORE UPDATE OR DELETE ON atrium.consent_ceremonies FOR EACH ROW EXECUTE FUNCTION atrium.consent_preserve_ceremony();
GRANT USAGE,CREATE ON SCHEMA atrium TO atrium_consent_executor;
GRANT SELECT(id,status,credential_version),UPDATE(id) ON atrium.users TO atrium_consent_executor;
GRANT SELECT(id,user_id,credential_version,audience,revoked_at_ms,expires_at_ms),UPDATE(id) ON atrium.user_sessions TO atrium_consent_executor;
GRANT SELECT ON atrium.organizations,atrium.properties,atrium.property_configurations,atrium.memberships,atrium.property_grants,atrium.channel_bindings,
 atrium.property_residents,atrium.resident_sources,atrium.resident_account_bindings,atrium.resident_enrollment_policies,atrium.service_cases,atrium.maintenance_policies,atrium.maintenance_vendors,atrium.maintenance_plans,atrium.maintenance_decisions,atrium.mfa_states,atrium.mfa_factors TO atrium_consent_executor;
GRANT UPDATE(id) ON atrium.organizations,atrium.properties TO atrium_consent_executor;
GRANT UPDATE(user_id) ON atrium.mfa_states TO atrium_consent_executor;
GRANT UPDATE(counter,counter_revision,backed_up,last_used_at_ms) ON atrium.mfa_factors TO atrium_consent_executor;
GRANT EXECUTE ON FUNCTION atrium.context(text),atrium.service_staff_context(),atrium.staff_context(),atrium.channel_context(),atrium.session_context_valid(),atrium.mfa_login_allowed(),atrium.staff_property_permission(text,text,text),atrium.channel_property_permission(text,text,text),atrium.can_access_property(text,text,text),atrium.mfa_hold_proof(uuid,text),atrium.mfa_now(),atrium.mfa_factor_json(atrium.mfa_factors),atrium.mfa_preserve_factor(),atrium.keep_workflow_evidence(),atrium.service_iso(timestamptz),atrium.service_keys(jsonb,text[]),atrium.service_text(jsonb,integer,integer,boolean),atrium.enrollment_uuid(jsonb),atrium.enrollment_version(jsonb),atrium.enrollment_digest(jsonb),atrium.enrollment_time(jsonb),atrium.enrollment_context_current(text,text,uuid,bigint,uuid,bigint,bigint),atrium.resident_context_state(atrium.property_residents),atrium.maintenance_emergencies(text),atrium.maintenance_restricted(text) TO atrium_consent_executor;
DO $$ DECLARE t text; f regprocedure; BEGIN
 FOREACH t IN ARRAY ARRAY['consent_policies','consent_rosters','consent_roster_members','consent_authorities','consent_requests','consent_recipients','consent_decisions','consent_commands'] LOOP EXECUTE format('GRANT SELECT,INSERT ON atrium.%I TO atrium_consent_executor',t); END LOOP;
 GRANT SELECT,INSERT,UPDATE,DELETE ON atrium.consent_ceremonies,atrium.consent_budgets TO atrium_consent_executor;
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='atrium' AND p.proname LIKE 'consent\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,atrium_app,atrium_authenticator',f); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO atrium_consent_executor',f);
 END LOOP;
END $$;
ALTER FUNCTION atrium.consent_staff(text,jsonb,bigint,uuid) OWNER TO atrium_consent_executor;
ALTER FUNCTION atrium.consent_resident(text,jsonb) OWNER TO atrium_consent_executor;
ALTER FUNCTION atrium.consent_planning(uuid[],bigint) OWNER TO atrium_consent_executor;
GRANT EXECUTE ON FUNCTION atrium.consent_staff(text,jsonb,bigint,uuid),atrium.consent_planning(uuid[],bigint) TO atrium_app;
GRANT EXECUTE ON FUNCTION atrium.consent_resident(text,jsonb) TO atrium_authenticator;
REVOKE CREATE ON SCHEMA atrium FROM atrium_consent_executor;
