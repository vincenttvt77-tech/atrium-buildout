-- Finite existing-member administration. Provision the NOLOGIN executor separately.
SET LOCAL ROLE atrium_admin;

CREATE TABLE atrium.organization_commands (
  organization_id atrium.record_id NOT NULL REFERENCES atrium.organizations(id),
  actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id),
  actor_credential_version atrium.positive_version NOT NULL,
  request_id atrium.record_id NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,actor_user_id,request_id)
);
CREATE TABLE atrium.organization_events (
  organization_id atrium.record_id NOT NULL REFERENCES atrium.organizations(id),
  actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id),
  request_id atrium.record_id NOT NULL,
  actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id),
  proof_id uuid NOT NULL REFERENCES atrium.mfa_assurances(id),
  membership_id atrium.record_id NOT NULL,
  before_access jsonb NOT NULL CHECK (jsonb_typeof(before_access)='object'),
  after_access jsonb NOT NULL CHECK (jsonb_typeof(after_access)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,actor_user_id,request_id),
  FOREIGN KEY (organization_id,actor_user_id,request_id)
    REFERENCES atrium.organization_commands(organization_id,actor_user_id,request_id),
  FOREIGN KEY (organization_id,membership_id) REFERENCES atrium.memberships(organization_id,id)
);
ALTER TABLE atrium.organization_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE atrium.organization_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE atrium.organization_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE atrium.organization_events FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON atrium.organization_commands TO atrium_admin USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON atrium.organization_events TO atrium_admin USING(true) WITH CHECK(true);
CREATE POLICY organization_command_read ON atrium.organization_commands FOR SELECT TO atrium_organization_executor
  USING(organization_id=atrium.context('organization_id') AND actor_user_id=atrium.context('actor_user_id'));
CREATE POLICY organization_command_append ON atrium.organization_commands FOR INSERT TO atrium_organization_executor
  WITH CHECK(organization_id=atrium.context('organization_id') AND actor_user_id=atrium.context('actor_user_id')
    AND actor_credential_version::text=atrium.context('credential_version'));
CREATE POLICY organization_event_append ON atrium.organization_events FOR INSERT TO atrium_organization_executor
  WITH CHECK(organization_id=atrium.context('organization_id') AND actor_user_id=atrium.context('actor_user_id')
    AND actor_session_id::text=atrium.context('session_id'));
CREATE TRIGGER immutable_organization_command BEFORE UPDATE OR DELETE ON atrium.organization_commands
  FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence();
CREATE TRIGGER immutable_organization_event BEFORE UPDATE OR DELETE ON atrium.organization_events
  FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence();

-- These policies belong only to a non-login command executor. Runtime roles gain
-- no raw directory access or writes. Helpers below have no runtime EXECUTE grant.
CREATE POLICY organization_member_read ON atrium.memberships FOR SELECT TO atrium_organization_executor
  USING(organization_id=atrium.context('organization_id') OR user_id=atrium.context('actor_user_id'));
CREATE POLICY organization_member_change ON atrium.memberships FOR UPDATE TO atrium_organization_executor
  USING(organization_id=atrium.context('organization_id')) WITH CHECK(organization_id=atrium.context('organization_id'));
CREATE POLICY organization_identity_read ON atrium.users FOR SELECT TO atrium_organization_executor USING(
  id=atrium.context('actor_user_id') OR EXISTS(SELECT 1 FROM atrium.memberships m
    WHERE m.organization_id=atrium.context('organization_id') AND m.user_id=users.id));
CREATE POLICY organization_identity_lock ON atrium.users FOR UPDATE TO atrium_organization_executor USING(
  id=atrium.context('actor_user_id') OR EXISTS(SELECT 1 FROM atrium.memberships m
    WHERE m.organization_id=atrium.context('organization_id') AND m.user_id=users.id)) WITH CHECK(false);
CREATE POLICY organization_identity_scope ON atrium.organizations FOR SELECT TO atrium_organization_executor USING(
  id=atrium.context('organization_id') OR EXISTS(SELECT 1 FROM atrium.memberships m
    WHERE m.organization_id=organizations.id AND m.user_id=atrium.context('actor_user_id')));
CREATE POLICY organization_identity_scope_lock ON atrium.organizations FOR UPDATE TO atrium_organization_executor
  USING(id=atrium.context('organization_id')) WITH CHECK(false);
CREATE POLICY organization_property_read ON atrium.properties FOR SELECT TO atrium_organization_executor
  USING(organization_id=atrium.context('organization_id'));
CREATE POLICY organization_property_lock ON atrium.properties FOR UPDATE TO atrium_organization_executor
  USING(organization_id=atrium.context('organization_id')) WITH CHECK(false);
CREATE POLICY organization_grant_read ON atrium.property_grants FOR SELECT TO atrium_organization_executor
  USING(organization_id=atrium.context('organization_id'));
CREATE POLICY organization_grant_change ON atrium.property_grants FOR UPDATE TO atrium_organization_executor
  USING(organization_id=atrium.context('organization_id')) WITH CHECK(organization_id=atrium.context('organization_id'));
CREATE POLICY organization_grant_append ON atrium.property_grants FOR INSERT TO atrium_organization_executor
  WITH CHECK(organization_id=atrium.context('organization_id'));

CREATE FUNCTION atrium.organization_context(p_organization text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT session_user='atrium_app' AND atrium.context('actor_user_id') IS NOT NULL
 AND atrium.context('credential_version') IS NOT NULL
 AND atrium.context('session_id') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 AND atrium.context('organization_id') IS NOT DISTINCT FROM p_organization
 AND atrium.context('property_id') IS NULL AND atrium.context('login_username') IS NULL
 AND atrium.context('channel_binding_id') IS NULL AND atrium.context('channel_binding_version') IS NULL
 AND atrium.context('channel_provider') IS NULL AND atrium.context('channel_external_id') IS NULL
$$;

CREATE FUNCTION atrium.organization_actor() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE m atrium.memberships%ROWTYPE; properties jsonb; fingerprint jsonb;
BEGIN
 SELECT a.* INTO m FROM atrium.memberships a JOIN atrium.users u ON u.id=a.user_id
 JOIN atrium.organizations o ON o.id=a.organization_id
 WHERE a.organization_id=atrium.context('organization_id') AND a.user_id=atrium.context('actor_user_id')
 AND a.status='active' AND a.role IN ('owner','admin') AND o.status='active' AND u.status='active'
 AND u.credential_version::text=atrium.context('credential_version');
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM atrium.properties WHERE organization_id=m.organization_id)>1000
 THEN RAISE EXCEPTION 'invalid_record' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(jsonb_agg(p.id ORDER BY p.id),'[]'::jsonb) INTO properties FROM atrium.properties p
 WHERE p.organization_id=m.organization_id AND p.status='active' AND (m.access='organization' OR EXISTS(
   SELECT 1 FROM atrium.property_grants g WHERE g.organization_id=m.organization_id AND g.membership_id=m.id AND g.property_id=p.id AND g.status='active'));
 SELECT jsonb_build_object('member',to_jsonb(m),'properties',properties,'grants',coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.property_id),'[]'::jsonb))
 INTO fingerprint FROM atrium.property_grants g WHERE g.organization_id=m.organization_id AND g.membership_id=m.id;
 RETURN jsonb_build_object('organizationId',m.organization_id,'userId',m.user_id,'membershipId',m.id,
 'credentialVersion',atrium.context('credential_version')::bigint,'role',m.role,'access',m.access,'propertyIds',properties,
 'permissionVersion',encode(sha256(convert_to(fingerprint::text,'UTF8')),'hex'));
END $$;

CREATE FUNCTION atrium.organization_can_manage(p_actor jsonb,p_member atrium.memberships) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT (p_actor->>'role'='owner' OR (p_member.role IN ('staff','viewer') AND p_member.user_id<>p_actor->>'userId'))
 AND (p_actor->>'access'='organization' OR (p_member.access='properties' AND NOT EXISTS(
   SELECT 1 FROM atrium.property_grants g WHERE g.organization_id=p_member.organization_id AND g.membership_id=p_member.id
   AND g.status='active' AND NOT (p_actor->'propertyIds' ? g.property_id::text))))
$$;
CREATE FUNCTION atrium.organization_member_json(p_member atrium.memberships,p_manage boolean) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('membershipId',p_member.id,'userId',u.id,'username',u.username,'displayName',u.display_name,'userStatus',u.status,
 'role',p_member.role,'status',p_member.status,'access',p_member.access,'version',p_member.permission_version,'canManage',p_manage,
 'propertyIds',CASE WHEN p_member.access='organization' THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(g.property_id ORDER BY g.property_id),'[]'::jsonb)
 FROM atrium.property_grants g WHERE g.organization_id=p_member.organization_id AND g.membership_id=p_member.id AND g.status='active') END)
 FROM atrium.users u WHERE u.id=p_member.user_id
$$;

CREATE FUNCTION atrium.list_administrable_organizations(p_proof uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 IF NOT coalesce(atrium.organization_context(NULL),false) THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='P0001'; END IF;
 IF NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name) ORDER BY x.id),'[]'::jsonb) INTO result
 FROM (SELECT o.id,o.name FROM atrium.organizations o JOIN atrium.memberships m ON m.organization_id=o.id
 WHERE m.user_id=atrium.context('actor_user_id') AND m.status='active' AND m.role IN ('owner','admin') AND o.status='active' ORDER BY o.id LIMIT 1001) x;
 IF jsonb_array_length(result)>1000 THEN RAISE EXCEPTION 'invalid_record' USING ERRCODE='P0001'; END IF;
 IF NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION atrium.organization_directory(p_organization text,p_proof uuid,p_limit integer,p_before text) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor jsonb; organization jsonb; properties jsonb; members jsonb; cursor text;
BEGIN
 IF NOT coalesce(atrium.organization_context(p_organization),false) THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='P0001'; END IF;
 IF p_organization IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
 OR (p_before IS NOT NULL AND p_before !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$') THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 IF NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM atrium.organizations WHERE id=p_organization FOR SHARE;
 actor:=atrium.organization_actor();
 SELECT jsonb_build_object('id',id,'name',name,'permissionVersion',permission_version) INTO organization FROM atrium.organizations WHERE id=p_organization;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'status',p.status,'permissionVersion',p.permission_version) ORDER BY p.id),'[]'::jsonb)
 INTO properties FROM atrium.properties p WHERE p.organization_id=p_organization AND (actor->>'access'='organization' OR EXISTS(
 SELECT 1 FROM atrium.property_grants g WHERE g.organization_id=p_organization AND g.membership_id=actor->>'membershipId' AND g.property_id=p.id AND g.status='active'));
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.id),'[]'::jsonb) INTO members FROM (
 SELECT m.id,atrium.organization_member_json(m,atrium.organization_can_manage(actor,m)) value
 FROM atrium.memberships m WHERE m.organization_id=p_organization AND (p_before IS NULL OR m.id>p_before)
 AND (m.user_id=actor->>'userId' OR atrium.organization_can_manage(actor,m)) ORDER BY m.id LIMIT p_limit+1) x;
 IF jsonb_array_length(members)>p_limit THEN members:=members-(p_limit); cursor:=members->(p_limit-1)->>'membershipId'; END IF;
 IF NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 PERFORM atrium.organization_actor();
 RETURN jsonb_build_object('organization',organization,'actor',actor,'properties',properties,'members',members,'nextCursor',cursor);
END $$;

CREATE FUNCTION atrium.replace_organization_member(p_input jsonb,p_proof uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org text; target_id text; actor_id text; target_user text; expected bigint; requested text[]; actor jsonb;
 target atrium.memberships%ROWTYPE; old_request atrium.organization_commands%ROWTYPE; target_status text;
 canonical jsonb; result jsonb; before_access jsonb; after_access jsonb; next_version bigint; owner_count integer;
BEGIN
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>8
 OR NOT(p_input ?& ARRAY['organizationId','membershipId','expectedVersion','role','status','access','propertyIds','requestId'])
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['organizationId','membershipId','role','status','access','requestId']) k WHERE jsonb_typeof(p_input->k) IS DISTINCT FROM 'string')
 OR jsonb_typeof(p_input->'propertyIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 IF jsonb_array_length(p_input->'propertyIds')>1000
 OR p_input->>'organizationId' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
 OR p_input->>'membershipId' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
 OR p_input->>'requestId' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
 OR p_input->>'role' NOT IN ('owner','admin','staff','viewer') OR p_input->>'status' NOT IN ('active','revoked')
 OR p_input->>'access' NOT IN ('organization','properties') OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number'
 OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,15}$' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'propertyIds') v WHERE jsonb_typeof(v)<>'string' OR v#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(array_agg(value ORDER BY value COLLATE "C"),'{}') INTO requested FROM jsonb_array_elements_text(p_input->'propertyIds');
 IF cardinality(requested)<>(SELECT count(DISTINCT x) FROM unnest(requested) x)
 OR (p_input->>'access'='organization' AND cardinality(requested)>0) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 expected:=(p_input->>'expectedVersion')::bigint;
 IF expected>9007199254740991 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 org:=p_input->>'organizationId'; target_id:=p_input->>'membershipId'; actor_id:=atrium.context('actor_user_id');
 canonical:=p_input||jsonb_build_object('propertyIds',to_jsonb(requested));
 IF NOT coalesce(atrium.organization_context(org),false) THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='P0001'; END IF;
 SELECT user_id INTO target_user FROM atrium.memberships WHERE organization_id=org AND id=target_id;
 -- Acquire all affected users in one stable order BEFORE the actor's proof fence.
 PERFORM 1 FROM atrium.users WHERE id=actor_id OR id=target_user ORDER BY id FOR UPDATE;
 IF NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM atrium.organizations WHERE id=org FOR UPDATE;
 SELECT * INTO old_request FROM atrium.organization_commands WHERE organization_id=org AND actor_user_id=actor_id AND request_id=p_input->>'requestId';
 IF FOUND THEN
   IF old_request.actor_credential_version::text IS DISTINCT FROM atrium.context('credential_version') OR old_request.manifest<>canonical
   THEN RAISE EXCEPTION 'version_conflict' USING ERRCODE='P0001'; END IF;
   IF NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
   RETURN old_request.result||jsonb_build_object('duplicate',true);
 END IF;
 actor:=atrium.organization_actor();
 PERFORM 1 FROM atrium.memberships WHERE organization_id=org AND id IN(target_id,actor->>'membershipId') ORDER BY id FOR UPDATE;
 PERFORM 1 FROM atrium.properties WHERE organization_id=org ORDER BY id FOR SHARE;
 PERFORM 1 FROM atrium.property_grants WHERE organization_id=org AND membership_id IN(target_id,actor->>'membershipId') ORDER BY membership_id,property_id FOR UPDATE;
 actor:=atrium.organization_actor();
 SELECT * INTO target FROM atrium.memberships WHERE organization_id=org AND id=target_id;
 IF NOT FOUND OR target.user_id IS DISTINCT FROM target_user OR NOT atrium.organization_can_manage(actor,target)
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF target.permission_version<>expected THEN RAISE EXCEPTION 'version_conflict' USING ERRCODE='P0001'; END IF;
 IF expected=9007199254740991 THEN RAISE EXCEPTION 'invalid_record' USING ERRCODE='P0001'; END IF;
 IF (actor->>'role'<>'owner' AND p_input->>'role' NOT IN ('staff','viewer'))
 OR (p_input->>'access'='organization' AND actor->>'access'<>'organization')
 OR EXISTS(SELECT 1 FROM unnest(requested) x WHERE NOT(actor->'propertyIds' ? x))
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 SELECT status INTO target_status FROM atrium.users WHERE id=target.user_id;
 IF p_input->>'status'='active' AND target_status<>'active' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 SELECT count(*) INTO owner_count FROM atrium.memberships m JOIN atrium.users u ON u.id=m.user_id
 WHERE m.organization_id=org AND m.status='active' AND m.role='owner' AND u.status='active';
 IF owner_count=0 OR (target.status='active' AND target.role='owner' AND target_status='active'
 AND (p_input->>'status'<>'active' OR p_input->>'role'<>'owner') AND owner_count<2)
 THEN RAISE EXCEPTION 'last_owner' USING ERRCODE='P0001'; END IF;
 before_access:=atrium.organization_member_json(target,true);
 IF EXISTS(SELECT 1 FROM atrium.property_grants g WHERE g.organization_id=org AND g.membership_id=target_id
 AND g.permission_version=9007199254740991 AND g.status IS DISTINCT FROM CASE WHEN p_input->>'access'='properties' AND g.property_id=ANY(requested) THEN 'active' ELSE 'revoked' END)
 THEN RAISE EXCEPTION 'invalid_record' USING ERRCODE='P0001'; END IF;
 UPDATE atrium.property_grants SET status=CASE WHEN p_input->>'access'='properties' AND property_id=ANY(requested) THEN 'active' ELSE 'revoked' END,
 permission_version=permission_version+1 WHERE organization_id=org AND membership_id=target_id
 AND status IS DISTINCT FROM CASE WHEN p_input->>'access'='properties' AND property_id=ANY(requested) THEN 'active' ELSE 'revoked' END;
 INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status)
 SELECT target_id,org,x,'active' FROM unnest(requested) x WHERE NOT EXISTS(SELECT 1 FROM atrium.property_grants g WHERE g.organization_id=org AND g.membership_id=target_id AND g.property_id=x);
 -- The finite runtime writer increments the aggregate once, including grant-only
 -- changes. Privileged maintenance must use this same organization/version protocol.
 next_version:=expected+1;
 UPDATE atrium.memberships SET role=p_input->>'role',status=p_input->>'status',access=p_input->>'access',permission_version=next_version
 WHERE organization_id=org AND id=target_id RETURNING * INTO target;
 after_access:=atrium.organization_member_json(target,true);
 result:=jsonb_build_object('organizationId',org,'membershipId',target_id,'userId',target.user_id,'version',next_version,
 'requestId',p_input->>'requestId','duplicate',false,'actorAccessChanged',target.user_id=actor_id,
 'role',target.role,'status',target.status,'access',target.access,'propertyIds',to_jsonb(requested));
 INSERT INTO atrium.organization_commands(organization_id,actor_user_id,actor_credential_version,request_id,manifest,result)
 VALUES(org,actor_id,atrium.context('credential_version')::bigint,p_input->>'requestId',canonical,result);
 INSERT INTO atrium.organization_events(organization_id,actor_user_id,request_id,actor_session_id,proof_id,membership_id,before_access,after_access)
 VALUES(org,actor_id,p_input->>'requestId',atrium.context('session_id')::uuid,p_proof,target_id,before_access,after_access);
 -- Self-demotion is an intentional transition. Recheck session/proof without
 -- requiring the actor to retain the privilege they just validly relinquished.
 IF NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 RETURN result;
END $$;

GRANT USAGE,CREATE ON SCHEMA atrium TO atrium_organization_executor;
GRANT USAGE ON TYPE atrium.record_id,atrium.positive_version TO atrium_organization_executor;
GRANT SELECT ON atrium.users,atrium.organizations,atrium.memberships,atrium.properties,atrium.property_grants,atrium.organization_commands TO atrium_organization_executor;
GRANT UPDATE(id) ON atrium.users,atrium.organizations,atrium.properties TO atrium_organization_executor;
GRANT UPDATE(role,status,access,permission_version) ON atrium.memberships TO atrium_organization_executor;
GRANT UPDATE(status,permission_version),INSERT ON atrium.property_grants TO atrium_organization_executor;
GRANT INSERT ON atrium.organization_commands,atrium.organization_events TO atrium_organization_executor;
GRANT EXECUTE ON FUNCTION atrium.context(text),atrium.mfa_hold_proof(uuid,text) TO atrium_organization_executor;
GRANT EXECUTE ON FUNCTION atrium.organization_context(text),atrium.organization_actor(),
 atrium.organization_can_manage(jsonb,atrium.memberships),atrium.organization_member_json(atrium.memberships,boolean) TO atrium_organization_executor;
ALTER FUNCTION atrium.list_administrable_organizations(uuid) OWNER TO atrium_organization_executor;
ALTER FUNCTION atrium.organization_directory(text,uuid,integer,text) OWNER TO atrium_organization_executor;
ALTER FUNCTION atrium.replace_organization_member(jsonb,uuid) OWNER TO atrium_organization_executor;
REVOKE ALL ON FUNCTION atrium.organization_context(text),atrium.organization_actor(),
 atrium.organization_can_manage(jsonb,atrium.memberships),atrium.organization_member_json(atrium.memberships,boolean),
 atrium.list_administrable_organizations(uuid),atrium.organization_directory(text,uuid,integer,text),atrium.replace_organization_member(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.list_administrable_organizations(uuid),atrium.organization_directory(text,uuid,integer,text),
 atrium.replace_organization_member(jsonb,uuid) TO atrium_app;
REVOKE CREATE ON SCHEMA atrium FROM atrium_organization_executor;
RESET ROLE;
