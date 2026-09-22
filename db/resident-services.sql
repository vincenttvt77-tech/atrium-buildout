-- Staff-only residency observations and maintenance intake. No provider execution.
SET LOCAL ROLE atrium_admin;

CREATE TABLE atrium.organization_people (
 organization_id atrium.record_id NOT NULL REFERENCES atrium.organizations(id), id uuid NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,id)
);
CREATE TABLE atrium.property_residents (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, person_id uuid NOT NULL,
 unit_id atrium.record_id NOT NULL, status text NOT NULL CHECK(status IN ('active','revoked')),
 version atrium.positive_version NOT NULL DEFAULT 1, source_id uuid NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id),
 FOREIGN KEY(organization_id,person_id) REFERENCES atrium.organization_people(organization_id,id)
);
CREATE TABLE atrium.resident_sources (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, resident_id uuid NOT NULL,
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120), relationship text NOT NULL CHECK(relationship IN ('leaseholder','occupant')),
 starts_on date NOT NULL, ends_on date, phone text, email text,
 source_kind text NOT NULL CHECK(source_kind='staff_review'), source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 3 AND 240),
 source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 80), observed_at timestamptz(3) NOT NULL, valid_until timestamptz(3) NOT NULL,
 reviewed_by atrium.record_id NOT NULL REFERENCES atrium.users(id), reviewed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,id), UNIQUE(organization_id,property_id,resident_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(ends_on IS NULL OR ends_on>starts_on), CHECK(valid_until>observed_at AND valid_until-observed_at<=interval '2160 hours'),
 CHECK(phone IS NULL OR (length(phone) BETWEEN 6 AND 32 AND phone ~ '^\+?[0-9][0-9 ()-]{5,30}$')),
 CHECK(email IS NULL OR (length(email) BETWEEN 3 AND 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
);
ALTER TABLE atrium.property_residents ADD CONSTRAINT resident_current_source
 FOREIGN KEY(organization_id,property_id,id,source_id) REFERENCES atrium.resident_sources(organization_id,property_id,resident_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE atrium.resident_events (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, resident_id uuid NOT NULL,
 resident_version atrium.positive_version NOT NULL, source_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('add_resident','review_resident','revoke_resident')), reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id),
 request_id atrium.record_id NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,id), UNIQUE(organization_id,property_id,resident_id,resident_version),
 FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id,source_id) REFERENCES atrium.resident_sources(organization_id,property_id,resident_id,id)
);
CREATE TABLE atrium.service_cases (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL,
 location_kind text NOT NULL CHECK(location_kind IN ('unit','common_area','unknown')), unit_id atrium.record_id, location_label text,
 intake_location_kind text NOT NULL CHECK(intake_location_kind IN ('unit','common_area','unknown')), intake_unit_id atrium.record_id, intake_location_label text,
 resident_id uuid, resident_id_at_intake uuid, resident_version_at_intake atrium.positive_version, resident_name_at_intake text,
 request_origin text NOT NULL CHECK(request_origin IN ('resident_report','staff_observation','unknown')),
 summary text NOT NULL CHECK(length(summary) BETWEEN 3 AND 160), description text NOT NULL CHECK(length(description)<=4000),
 category text NOT NULL CHECK(category IN ('plumbing','electrical','heating_cooling','appliance','pest','access','other')),
 reported_priority text NOT NULL CHECK(reported_priority IN ('routine','urgent','emergency')),
 reporter_name text, reporter_phone text, reporter_email text, access_notes text NOT NULL CHECK(length(access_notes)<=1000),
 state text NOT NULL CHECK(state IN ('needs_triage','waiting_information','management_review','ready_for_planning','emergency_review')),
 priority text NOT NULL CHECK(priority IN ('routine','urgent','emergency')), emergency_kinds text[] NOT NULL DEFAULT '{}',
 version atrium.positive_version NOT NULL DEFAULT 1, created_by atrium.record_id NOT NULL REFERENCES atrium.users(id),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,id), FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id_at_intake) REFERENCES atrium.property_residents(organization_id,property_id,id),
 CHECK((location_kind='unit' AND unit_id IS NOT NULL AND location_label IS NULL) OR
   (location_kind IN ('common_area','unknown') AND unit_id IS NULL AND length(location_label) BETWEEN 1 AND 160)),
 CHECK((intake_location_kind='unit' AND intake_unit_id IS NOT NULL AND intake_location_label IS NULL) OR
   (intake_location_kind IN ('common_area','unknown') AND intake_unit_id IS NULL AND length(intake_location_label) BETWEEN 1 AND 160)),
 CHECK(resident_id IS NULL OR location_kind='unit'),
 CHECK((resident_id_at_intake IS NULL AND resident_version_at_intake IS NULL AND resident_name_at_intake IS NULL) OR
   (resident_id_at_intake IS NOT NULL AND resident_version_at_intake IS NOT NULL AND resident_name_at_intake IS NOT NULL AND intake_location_kind='unit')),
 CHECK(emergency_kinds <@ ARRAY['gas','smoke_or_fire','carbon_monoxide','flooding','no_heat','injury','intruder','structural']::text[] AND array_position(emergency_kinds,NULL) IS NULL),
 CHECK((priority='emergency')=(state='emergency_review')),
 CHECK((cardinality(emergency_kinds)=0 AND reported_priority<>'emergency') OR priority='emergency'),
 CHECK(reporter_name IS NULL OR length(reporter_name) BETWEEN 1 AND 120),
 CHECK(reporter_phone IS NULL OR (length(reporter_phone) BETWEEN 6 AND 32 AND reporter_phone ~ '^\+?[0-9][0-9 ()-]{5,30}$')),
 CHECK(reporter_email IS NULL OR (length(reporter_email) BETWEEN 3 AND 254 AND reporter_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
);
CREATE TABLE atrium.service_events (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, case_id uuid NOT NULL,
 case_version atrium.positive_version NOT NULL, kind text NOT NULL CHECK(kind IN ('intake','note','triage','context')),
 actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id),
 request_id atrium.record_id NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 note text NOT NULL CHECK(length(note)<=4000), state text NOT NULL, priority text NOT NULL, emergency_kinds text[] NOT NULL,
 context_location_kind text NOT NULL CHECK(context_location_kind IN ('unit','common_area','unknown')), context_unit_id atrium.record_id, context_location_label text,
 context_resident_id uuid, context_resident_version atrium.positive_version, context_resident_name text,
 PRIMARY KEY(organization_id,property_id,id), UNIQUE(organization_id,property_id,case_id,case_version),
 FOREIGN KEY(organization_id,property_id,case_id) REFERENCES atrium.service_cases(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,context_resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id),
 CHECK((context_location_kind='unit' AND context_unit_id IS NOT NULL AND context_location_label IS NULL) OR
   (context_location_kind IN ('common_area','unknown') AND context_unit_id IS NULL AND length(context_location_label) BETWEEN 1 AND 160)),
 CHECK((context_resident_id IS NULL AND context_resident_version IS NULL AND context_resident_name IS NULL) OR
   (context_resident_id IS NOT NULL AND context_resident_version IS NOT NULL AND context_resident_name IS NOT NULL AND context_location_kind='unit'))
);
CREATE TABLE atrium.service_commands (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL,
 actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_credential_version atrium.positive_version NOT NULL,
 request_id atrium.record_id NOT NULL, manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND pg_column_size(manifest)<=32768),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 action text NOT NULL CHECK(action IN ('add_resident','review_resident','revoke_resident','create_request','add_note','triage_request','update_context')),
 resource text NOT NULL CHECK(resource IN ('resident','request')), resource_id uuid NOT NULL, resource_version atrium.positive_version NOT NULL,
 configuration_version atrium.positive_version NOT NULL, committed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,actor_user_id,request_id),
 FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id),
 FOREIGN KEY(organization_id,property_id,configuration_version) REFERENCES atrium.property_configurations(organization_id,property_id,version)
);
ALTER TABLE atrium.resident_events ADD FOREIGN KEY(organization_id,property_id,actor_user_id,request_id)
 REFERENCES atrium.service_commands(organization_id,property_id,actor_user_id,request_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE atrium.service_events ADD FOREIGN KEY(organization_id,property_id,actor_user_id,request_id)
 REFERENCES atrium.service_commands(organization_id,property_id,actor_user_id,request_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX resident_page ON atrium.property_residents(organization_id,property_id,created_at DESC,id DESC);
CREATE INDEX resident_unit ON atrium.property_residents(organization_id,property_id,unit_id,created_at DESC,id DESC);
CREATE INDEX resident_person ON atrium.property_residents(organization_id,person_id);
CREATE INDEX source_resident ON atrium.resident_sources(organization_id,property_id,resident_id);
CREATE INDEX case_page ON atrium.service_cases(organization_id,property_id,created_at DESC,id DESC);
CREATE INDEX case_unit ON atrium.service_cases(organization_id,property_id,unit_id,created_at DESC,id DESC);
CREATE INDEX case_resident ON atrium.service_cases(organization_id,property_id,resident_id);
CREATE INDEX event_page ON atrium.service_events(organization_id,property_id,case_id,created_at DESC,id DESC);

CREATE FUNCTION atrium.service_staff_context() RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT session_user='atrium_app' AND atrium.context('session_id') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 AND atrium.context('actor_user_id') IS NOT NULL AND atrium.context('credential_version') IS NOT NULL
 AND atrium.context('login_username') IS NULL AND atrium.context('channel_binding_id') IS NULL
 AND atrium.context('channel_binding_version') IS NULL AND atrium.context('channel_provider') IS NULL AND atrium.context('channel_external_id') IS NULL
 AND atrium.staff_context()
$$;
-- Executor can see only the current actor and property while evaluating existing live authorization.
CREATE POLICY service_actor ON atrium.users FOR SELECT TO atrium_resident_services_executor USING(id=atrium.context('actor_user_id'));
CREATE POLICY service_session ON atrium.user_sessions FOR SELECT TO atrium_resident_services_executor
 USING(user_id=atrium.context('actor_user_id') AND id::text=atrium.context('session_id') AND credential_version::text=atrium.context('credential_version'));
CREATE POLICY service_membership ON atrium.memberships FOR SELECT TO atrium_resident_services_executor
 USING(user_id=atrium.context('actor_user_id') AND organization_id=atrium.context('organization_id'));
CREATE POLICY service_grant ON atrium.property_grants FOR SELECT TO atrium_resident_services_executor USING(organization_id=atrium.context('organization_id')
 AND EXISTS(SELECT 1 FROM atrium.memberships m WHERE m.id=property_grants.membership_id AND m.user_id=atrium.context('actor_user_id')));
CREATE POLICY service_organization ON atrium.organizations FOR SELECT TO atrium_resident_services_executor USING(id=atrium.context('organization_id'));
CREATE POLICY service_property ON atrium.properties FOR SELECT TO atrium_resident_services_executor
 USING(organization_id=atrium.context('organization_id') AND id=atrium.context('property_id'));
CREATE POLICY service_property_lock ON atrium.properties FOR UPDATE TO atrium_resident_services_executor
 USING(organization_id=atrium.context('organization_id') AND id=atrium.context('property_id')) WITH CHECK(false);
CREATE POLICY service_configuration ON atrium.property_configurations FOR SELECT TO atrium_resident_services_executor
 USING(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id') AND status='published');
CREATE POLICY service_no_channel ON atrium.channel_bindings FOR SELECT TO atrium_resident_services_executor USING(false);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['organization_people','property_residents','resident_sources','resident_events','service_cases','service_events','service_commands'] LOOP
  EXECUTE format('ALTER TABLE atrium.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE atrium.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY maintenance ON atrium.%I TO atrium_admin USING(true) WITH CHECK(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['property_residents','resident_sources','resident_events','service_cases','service_events','service_commands'] LOOP
  EXECUTE format('CREATE POLICY staff_read ON atrium.%I FOR SELECT TO atrium_app,atrium_resident_services_executor USING(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id'') AND (SELECT atrium.service_staff_context() AND atrium.can_access_property(atrium.context(''organization_id''),atrium.context(''property_id''),''operate'')))',t);
  EXECUTE format('CREATE POLICY command_append ON atrium.%I FOR INSERT TO atrium_resident_services_executor WITH CHECK(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id''))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['property_residents','service_cases'] LOOP
  EXECUTE format('CREATE POLICY command_change ON atrium.%I FOR UPDATE TO atrium_resident_services_executor USING(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id'')) WITH CHECK(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id''))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['organization_people','resident_sources','resident_events','service_events','service_commands'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON atrium.%I FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence()',t);
 END LOOP;
END $$;
CREATE POLICY person_append ON atrium.organization_people FOR INSERT TO atrium_resident_services_executor
 WITH CHECK(organization_id=atrium.context('organization_id'));
CREATE POLICY person_read ON atrium.organization_people FOR SELECT TO atrium_app,atrium_resident_services_executor
 USING(organization_id=atrium.context('organization_id') AND EXISTS(SELECT 1 FROM atrium.property_residents r
 WHERE r.organization_id=organization_people.organization_id AND r.person_id=organization_people.id AND r.property_id=atrium.context('property_id')));

CREATE FUNCTION atrium.preserve_service_identity() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.organization_id,NEW.property_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.property_id,OLD.id,OLD.created_at)
 THEN RAISE EXCEPTION 'Service ownership is immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='property_residents' THEN
  IF (NEW.person_id,NEW.unit_id) IS DISTINCT FROM (OLD.person_id,OLD.unit_id)
  THEN RAISE EXCEPTION 'Resident ownership is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='service_cases' THEN
  IF (to_jsonb(NEW)-ARRAY['version','state','priority','emergency_kinds','updated_at','location_kind','unit_id','location_label','resident_id']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['version','state','priority','emergency_kinds','updated_at','location_kind','unit_id','location_label','resident_id'])
   OR NOT NEW.emergency_kinds @> OLD.emergency_kinds OR (OLD.priority='emergency' AND NEW.priority<>'emergency')
  THEN RAISE EXCEPTION 'Intake and emergency evidence are immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_identity BEFORE UPDATE OR DELETE ON atrium.property_residents FOR EACH ROW EXECUTE FUNCTION atrium.preserve_service_identity();
CREATE TRIGGER service_identity BEFORE UPDATE OR DELETE ON atrium.service_cases FOR EACH ROW EXECUTE FUNCTION atrium.preserve_service_identity();

CREATE FUNCTION atrium.service_iso(p_time timestamptz) RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT to_char(p_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE FUNCTION atrium.resident_context_state(p_resident atrium.property_residents) RETURNS text LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_resident.status='revoked' THEN 'revoked'
  WHEN (clock_timestamp() AT TIME ZONE p.time_zone)::date<s.starts_on THEN 'not_started'
  WHEN s.ends_on IS NOT NULL AND (clock_timestamp() AT TIME ZONE p.time_zone)::date>=s.ends_on THEN 'ended'
  WHEN s.valid_until<=clock_timestamp() THEN 'expired' ELSE 'current' END
 FROM atrium.resident_sources s JOIN atrium.properties p ON p.organization_id=s.organization_id AND p.id=s.property_id
 WHERE s.organization_id=p_resident.organization_id AND s.property_id=p_resident.property_id AND s.id=p_resident.source_id
$$;
CREATE FUNCTION atrium.resident_json(p_resident atrium.property_residents) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p_resident.id,'personId',p_resident.person_id,'organizationId',p_resident.organization_id,'propertyId',p_resident.property_id,
 'unitId',p_resident.unit_id,'status',p_resident.status,'version',p_resident.version,'createdAt',atrium.service_iso(p_resident.created_at),'updatedAt',atrium.service_iso(p_resident.updated_at),
 'displayName',s.display_name,'relationship',s.relationship,'startsOn',to_char(s.starts_on,'YYYY-MM-DD'),'endsOn',to_char(s.ends_on,'YYYY-MM-DD'),
 'phone',s.phone,'email',s.email,'reviewedBy',s.reviewed_by,'reviewedAt',atrium.service_iso(s.reviewed_at),'contextState',atrium.resident_context_state(p_resident),
 'source',jsonb_build_object('kind',s.source_kind,'reference',s.source_reference,'version',s.source_version,'observedAt',atrium.service_iso(s.observed_at),'validUntil',atrium.service_iso(s.valid_until)))
 FROM atrium.resident_sources s WHERE s.organization_id=p_resident.organization_id AND s.property_id=p_resident.property_id AND s.id=p_resident.source_id
$$;
CREATE FUNCTION atrium.service_case_json(c atrium.service_cases) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',c.id,'organizationId',c.organization_id,'propertyId',c.property_id,'version',c.version,
 'location',CASE WHEN c.location_kind='unit' THEN jsonb_build_object('kind','unit','unitId',c.unit_id) ELSE jsonb_build_object('kind',c.location_kind,'label',c.location_label) END,
 'intakeLocation',CASE WHEN c.intake_location_kind='unit' THEN jsonb_build_object('kind','unit','unitId',c.intake_unit_id) ELSE jsonb_build_object('kind',c.intake_location_kind,'label',c.intake_location_label) END,
 'residentId',c.resident_id,'residentIdAtIntake',c.resident_id_at_intake,'residentVersionAtIntake',c.resident_version_at_intake,'residentNameAtIntake',c.resident_name_at_intake,
 'requestOrigin',c.request_origin,'summary',c.summary,'description',c.description,'category',c.category,'reportedPriority',c.reported_priority,
 'reporterName',c.reporter_name,'reporterPhone',c.reporter_phone,'reporterEmail',c.reporter_email,'accessNotes',c.access_notes,
 'state',c.state,'priority',c.priority,'emergencyKinds',to_jsonb(c.emergency_kinds),'createdBy',c.created_by,
 'createdAt',atrium.service_iso(c.created_at),'updatedAt',atrium.service_iso(c.updated_at),
 'dispatchStatus','not_dispatched','notificationStatus','not_sent','callerIdentityVerified',false,'entryAuthorized',false)
$$;
CREATE FUNCTION atrium.service_event_json(e atrium.service_events) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',e.id,'caseId',e.case_id,'caseVersion',e.case_version,'kind',e.kind,'actorUserId',e.actor_user_id,
 'createdAt',atrium.service_iso(e.created_at),'note',e.note,'state',e.state,'priority',e.priority,
 'contextLocation',CASE WHEN e.context_location_kind='unit' THEN jsonb_build_object('kind','unit','unitId',e.context_unit_id) ELSE jsonb_build_object('kind',e.context_location_kind,'label',e.context_location_label) END,
 'contextResidentId',e.context_resident_id,'contextResidentVersion',e.context_resident_version,'contextResidentName',e.context_resident_name)
$$;

-- Structural checks also protect direct finite-command callers, not just HTTP parsing.
CREATE FUNCTION atrium.service_keys(v jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_typeof(v)='object' AND v ?& keys AND (SELECT count(*) FROM jsonb_object_keys(v))=cardinality(keys)
$$;
CREATE FUNCTION atrium.service_text(v jsonb,min_length integer,max_length integer,nullable boolean DEFAULT false) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce((nullable AND v='null'::jsonb) OR (jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN min_length AND max_length
 AND (v#>>'{}') !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),false)
$$;
CREATE FUNCTION atrium.service_id(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$',false)
$$;

CREATE FUNCTION atrium.execute_resident_service(p_input jsonb,p_configuration bigint,p_emergency text[]) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE org text:=atrium.context('organization_id'); prop text:=atrium.context('property_id'); actor text:=atrium.context('actor_user_id');
 action text; permission text; details jsonb; src jsonb; intake jsonb; loc jsonb; config jsonb; zone text; rid uuid; sid uuid; pid uuid;
 resident atrium.property_residents%ROWTYPE; request atrium.service_cases%ROWTYPE; prior atrium.service_commands%ROWTYPE;
 source_row atrium.resident_sources%ROWTYPE; expected bigint; next_version bigint; stamp timestamptz(3); digest text;
 state text; priority text; kinds text[]; resource text; note text; event_kind text; result jsonb; input_keys text[];
BEGIN
 IF NOT coalesce(atrium.service_staff_context(),false) OR NOT atrium.hold_current_session()
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR NOT atrium.service_id(p_input->'requestId')
 OR jsonb_typeof(p_input->'action') IS DISTINCT FROM 'string' OR pg_column_size(p_input)>32768
 OR p_configuration IS NULL OR p_configuration NOT BETWEEN 1 AND 9007199254740991
 OR p_emergency IS NULL OR cardinality(p_emergency)>8 OR array_position(p_emergency,NULL) IS NOT NULL
 OR NOT p_emergency <@ ARRAY['gas','smoke_or_fire','carbon_monoxide','flooding','no_heat','injury','intruder','structural']::text[]
 THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
 action:=p_input->>'action'; permission:=CASE WHEN action IN ('add_resident','review_resident','revoke_resident') THEN 'configure' ELSE 'operate' END;
 IF NOT atrium.can_access_property(org,prop,permission) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 SELECT c.configuration,p.time_zone INTO config,zone FROM atrium.properties p JOIN atrium.property_configurations c
 ON c.organization_id=p.organization_id AND c.property_id=p.id AND c.version=p.published_configuration_version
 WHERE p.organization_id=org AND p.id=prop AND c.version=p_configuration AND c.status='published' FOR SHARE OF p;
 IF NOT FOUND THEN RAISE EXCEPTION 'property_configuration_changed' USING ERRCODE='P0001'; END IF;
 -- One key cannot race a second insert. A collision only serializes unrelated requests.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(org,prop,actor,p_input->>'requestId')::text,0));
 digest:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
 SELECT * INTO prior FROM atrium.service_commands WHERE organization_id=org AND property_id=prop AND actor_user_id=actor AND request_id=p_input->>'requestId';
 IF FOUND THEN
  IF prior.actor_credential_version::text IS DISTINCT FROM atrium.context('credential_version') OR prior.manifest<>p_input OR prior.manifest_sha256<>digest
  THEN RAISE EXCEPTION 'service_request_conflict' USING ERRCODE='P0001'; END IF;
  IF NOT atrium.hold_current_session() OR NOT atrium.can_access_property(org,prop,permission) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('requestId',prior.request_id,'action',prior.action,'resource',prior.resource,'id',prior.resource_id,'version',prior.resource_version,'committedAt',atrium.service_iso(prior.committed_at),'replayed',true);
 END IF;
 input_keys:=CASE action WHEN 'add_resident' THEN ARRAY['action','requestId','details','reason'] WHEN 'review_resident' THEN ARRAY['action','requestId','id','expectedVersion','details','reason']
 WHEN 'revoke_resident' THEN ARRAY['action','requestId','id','expectedVersion','reason'] WHEN 'create_request' THEN ARRAY['action','requestId','intake']
 WHEN 'add_note' THEN ARRAY['action','requestId','id','expectedVersion','note'] WHEN 'triage_request' THEN ARRAY['action','requestId','id','expectedVersion','note','state','priority']
 WHEN 'update_context' THEN ARRAY['action','requestId','id','expectedVersion','location','residentId','note'] END;
 IF input_keys IS NULL OR NOT coalesce(atrium.service_keys(p_input,input_keys),false) THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
 IF action NOT IN ('add_resident','create_request') THEN
  IF NOT atrium.service_id(p_input->'id') OR p_input->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,15}$'
  THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
  expected:=(p_input->>'expectedVersion')::bigint; rid:=(p_input->>'id')::uuid;
  IF expected>9007199254740991 THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
 END IF;
 IF action IN ('add_resident','review_resident','revoke_resident') THEN
  resource:='resident'; note:=p_input->>'reason';
  IF NOT atrium.service_text(p_input->'reason',3,1000) THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
  IF action<>'add_resident' THEN
   SELECT * INTO resident FROM atrium.property_residents WHERE organization_id=org AND property_id=prop AND id=rid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'service_not_found' USING ERRCODE='P0001'; END IF;
   IF resident.version<>expected THEN RAISE EXCEPTION 'service_version_conflict' USING ERRCODE='P0001'; END IF;
   IF resident.version=9007199254740991 THEN RAISE EXCEPTION 'service_unavailable' USING ERRCODE='P0001'; END IF;
  END IF;
  IF action<>'revoke_resident' THEN
   details:=p_input->'details'; src:=details->'source';
   IF NOT coalesce(atrium.service_keys(details,ARRAY['displayName','relationship','startsOn','endsOn','phone','email','source']||CASE WHEN action='add_resident' THEN ARRAY['unitId'] ELSE '{}'::text[] END),false)
   OR NOT coalesce(atrium.service_keys(src,ARRAY['kind','reference','version','observedAt','validUntil']),false)
   OR NOT atrium.service_text(details->'displayName',1,120) OR details->>'relationship' NOT IN ('leaseholder','occupant') OR jsonb_typeof(details->'relationship') IS DISTINCT FROM 'string'
   OR NOT atrium.service_text(details->'startsOn',10,10) OR details->>'startsOn' !~ '^\d{4}-\d\d-\d\d$'
   OR NOT atrium.service_text(details->'endsOn',10,10,true) OR (details->>'endsOn' IS NOT NULL AND details->>'endsOn' !~ '^\d{4}-\d\d-\d\d$')
   OR NOT atrium.service_text(details->'phone',6,32,true) OR NOT atrium.service_text(details->'email',3,254,true)
   OR src->>'kind' IS DISTINCT FROM 'staff_review' OR NOT atrium.service_text(src->'reference',3,240) OR NOT atrium.service_text(src->'version',1,80)
   OR NOT atrium.service_text(src->'observedAt',24,24) OR src->>'observedAt' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
   OR NOT atrium.service_text(src->'validUntil',24,24) OR src->>'validUntil' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
   THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
   IF (src->>'observedAt')::timestamptz>clock_timestamp() OR (src->>'validUntil')::timestamptz<=clock_timestamp()
   THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
   IF action='add_resident' AND (NOT atrium.service_id(details->'unitId') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config->'inventory') u WHERE u->>'unitId'=details->>'unitId'))
   THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
   IF action='review_resident' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config->'inventory') u WHERE u->>'unitId'=resident.unit_id)
   THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
   sid:=gen_random_uuid();
  ELSE sid:=resident.source_id; END IF;
  stamp:=clock_timestamp();
  IF action='add_resident' THEN
   rid:=gen_random_uuid(); pid:=gen_random_uuid(); next_version:=1;
   INSERT INTO atrium.organization_people(organization_id,id,created_at) VALUES(org,pid,stamp);
   INSERT INTO atrium.property_residents(organization_id,property_id,id,person_id,unit_id,status,source_id,created_at,updated_at)
   VALUES(org,prop,rid,pid,details->>'unitId','active',sid,stamp,stamp);
  ELSE
   next_version:=resident.version+1;
   UPDATE atrium.property_residents SET status=CASE WHEN action='revoke_resident' THEN 'revoked' ELSE 'active' END,
   source_id=sid,version=next_version,updated_at=stamp WHERE organization_id=org AND property_id=prop AND id=rid;
  END IF;
  IF action<>'revoke_resident' THEN
   INSERT INTO atrium.resident_sources(organization_id,property_id,id,resident_id,display_name,relationship,starts_on,ends_on,phone,email,
   source_kind,source_reference,source_version,observed_at,valid_until,reviewed_by,reviewed_at)
   VALUES(org,prop,sid,rid,details->>'displayName',details->>'relationship',(details->>'startsOn')::date,(details->>'endsOn')::date,details->>'phone',details->>'email',
   'staff_review',src->>'reference',src->>'version',(src->>'observedAt')::timestamptz,(src->>'validUntil')::timestamptz,actor,stamp);
  END IF;
  INSERT INTO atrium.resident_events(organization_id,property_id,id,resident_id,resident_version,source_id,kind,reason,actor_user_id,actor_session_id,request_id,created_at)
  VALUES(org,prop,gen_random_uuid(),rid,next_version,sid,action,note,actor,atrium.context('session_id')::uuid,p_input->>'requestId',stamp);
 ELSE
  resource:='request';
  IF action='create_request' THEN
   intake:=p_input->'intake';loc:=intake->'location';
   IF NOT coalesce(atrium.service_keys(intake,ARRAY['location','residentId','requestOrigin','summary','description','category','reportedPriority','reporterName','reporterPhone','reporterEmail','accessNotes']),false)
   OR jsonb_typeof(intake->'requestOrigin') IS DISTINCT FROM 'string' OR intake->>'requestOrigin' NOT IN ('resident_report','staff_observation','unknown')
   OR NOT atrium.service_text(intake->'summary',3,160) OR NOT atrium.service_text(intake->'description',0,4000)
   OR NOT atrium.service_text(intake->'accessNotes',0,1000) OR NOT atrium.service_text(intake->'reporterName',1,120,true)
   OR NOT atrium.service_text(intake->'reporterPhone',6,32,true) OR NOT atrium.service_text(intake->'reporterEmail',3,254,true)
   OR jsonb_typeof(intake->'category') IS DISTINCT FROM 'string' OR intake->>'category' NOT IN ('plumbing','electrical','heating_cooling','appliance','pest','access','other')
   OR jsonb_typeof(intake->'reportedPriority') IS DISTINCT FROM 'string' OR intake->>'reportedPriority' NOT IN ('routine','urgent','emergency')
   OR jsonb_typeof(loc->'kind') IS DISTINCT FROM 'string' OR loc->>'kind' NOT IN ('unit','common_area','unknown')
   THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
   IF loc->>'kind'='unit' THEN
    IF NOT coalesce(atrium.service_keys(loc,ARRAY['kind','unitId']),false) OR NOT atrium.service_id(loc->'unitId')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config->'inventory') u WHERE u->>'unitId'=loc->>'unitId') THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
   ELSE
    IF NOT coalesce(atrium.service_keys(loc,ARRAY['kind','label']),false) OR NOT atrium.service_text(loc->'label',1,160)
    THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
   END IF;
   IF intake->'residentId' IS DISTINCT FROM 'null'::jsonb THEN
    IF NOT atrium.service_id(intake->'residentId') OR intake->>'residentId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR loc->>'kind'<>'unit'
    THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
    SELECT * INTO resident FROM atrium.property_residents WHERE organization_id=org AND property_id=prop AND id=(intake->>'residentId')::uuid FOR SHARE;
    IF NOT FOUND OR resident.unit_id IS DISTINCT FROM loc->>'unitId' THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
    SELECT * INTO source_row FROM atrium.resident_sources WHERE organization_id=org AND property_id=prop AND id=resident.source_id;
   END IF;
   rid:=gen_random_uuid();next_version:=1;stamp:=clock_timestamp();note:=intake->>'description';event_kind:='intake';
   SELECT coalesce(array_agg(DISTINCT k ORDER BY k),'{}') INTO kinds FROM unnest(p_emergency) k;
   priority:=CASE WHEN cardinality(kinds)>0 THEN 'emergency' ELSE intake->>'reportedPriority' END;
   state:=CASE WHEN priority='emergency' THEN 'emergency_review' ELSE 'needs_triage' END;
   INSERT INTO atrium.service_cases(organization_id,property_id,id,location_kind,unit_id,location_label,intake_location_kind,intake_unit_id,intake_location_label,resident_id,resident_id_at_intake,resident_version_at_intake,resident_name_at_intake,
   request_origin,summary,description,category,reported_priority,reporter_name,reporter_phone,reporter_email,access_notes,state,priority,emergency_kinds,created_by,created_at,updated_at)
   VALUES(org,prop,rid,loc->>'kind',loc->>'unitId',loc->>'label',loc->>'kind',loc->>'unitId',loc->>'label',resident.id,resident.id,resident.version,source_row.display_name,
   intake->>'requestOrigin',intake->>'summary',intake->>'description',intake->>'category',intake->>'reportedPriority',intake->>'reporterName',intake->>'reporterPhone',intake->>'reporterEmail',intake->>'accessNotes',state,priority,kinds,actor,stamp,stamp);
  ELSE
   IF NOT atrium.service_text(p_input->'note',3,4000) THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
   SELECT * INTO request FROM atrium.service_cases WHERE organization_id=org AND property_id=prop AND id=rid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'service_not_found' USING ERRCODE='P0001'; END IF;
   IF request.version<>expected THEN RAISE EXCEPTION 'service_version_conflict' USING ERRCODE='P0001'; END IF;
   IF request.version=9007199254740991 THEN RAISE EXCEPTION 'service_unavailable' USING ERRCODE='P0001'; END IF;
   -- Case first, then the selected resident. Residency reviews never lock cases.
   loc:=CASE WHEN request.location_kind='unit' THEN jsonb_build_object('kind','unit','unitId',request.unit_id)
    ELSE jsonb_build_object('kind',request.location_kind,'label',request.location_label) END;
   sid:=request.resident_id;
   IF action='update_context' THEN
    loc:=p_input->'location';
    IF jsonb_typeof(loc->'kind') IS DISTINCT FROM 'string' OR loc->>'kind' NOT IN ('unit','common_area','unknown')
    THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
    IF loc->>'kind'='unit' THEN
     IF NOT coalesce(atrium.service_keys(loc,ARRAY['kind','unitId']),false) OR NOT atrium.service_id(loc->'unitId')
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config->'inventory') u WHERE u->>'unitId'=loc->>'unitId')
     THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
    ELSE
     IF NOT coalesce(atrium.service_keys(loc,ARRAY['kind','label']),false) OR NOT atrium.service_text(loc->'label',1,160)
     THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
    END IF;
    IF p_input->'residentId'='null'::jsonb THEN sid:=NULL;
    ELSE
     IF NOT atrium.service_id(p_input->'residentId') OR p_input->>'residentId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR loc->>'kind'<>'unit'
     THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
     sid:=(p_input->>'residentId')::uuid;
    END IF;
   END IF;
   IF sid IS NOT NULL THEN
    SELECT * INTO resident FROM atrium.property_residents WHERE organization_id=org AND property_id=prop AND id=sid FOR SHARE;
    IF NOT FOUND OR resident.unit_id IS DISTINCT FROM loc->>'unitId' THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
    SELECT * INTO source_row FROM atrium.resident_sources WHERE organization_id=org AND property_id=prop AND id=resident.source_id;
   END IF;
   SELECT coalesce(array_agg(DISTINCT k ORDER BY k),'{}') INTO kinds FROM unnest(request.emergency_kinds||p_emergency) k;
   note:=p_input->>'note';state:=request.state;priority:=request.priority;event_kind:='note';
   IF action='update_context' THEN state:='needs_triage';event_kind:='context'; END IF;
   IF action='triage_request' THEN
    IF jsonb_typeof(p_input->'state') IS DISTINCT FROM 'string' OR p_input->>'state' NOT IN ('waiting_information','management_review','ready_for_planning')
    OR jsonb_typeof(p_input->'priority') IS DISTINCT FROM 'string' OR p_input->>'priority' NOT IN ('routine','urgent')
    THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
    IF request.priority='emergency' AND cardinality(p_emergency)=0 THEN RAISE EXCEPTION 'service_emergency_hold' USING ERRCODE='P0001'; END IF;
    state:=p_input->>'state';priority:=p_input->>'priority';event_kind:='triage';
    IF state='ready_for_planning' AND cardinality(kinds)=0 AND request.location_kind='unit'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config->'inventory') u WHERE u->>'unitId'=request.unit_id)
    THEN RAISE EXCEPTION 'service_context_required' USING ERRCODE='P0001'; END IF;
    IF state='ready_for_planning' AND cardinality(kinds)=0 AND (request.location_kind='unknown' OR
     (request.location_kind='unit' AND request.request_origin<>'staff_observation' AND (resident.id IS NULL OR atrium.resident_context_state(resident) IS DISTINCT FROM 'current')))
    THEN RAISE EXCEPTION 'service_context_required' USING ERRCODE='P0001'; END IF;
   END IF;
   IF request.priority='emergency' OR cardinality(kinds)>0 THEN state:='emergency_review';priority:='emergency'; END IF;
   stamp:=clock_timestamp();next_version:=request.version+1;
   UPDATE atrium.service_cases SET version=next_version,state=state,priority=priority,emergency_kinds=kinds,updated_at=stamp,
   location_kind=loc->>'kind',unit_id=loc->>'unitId',location_label=loc->>'label',resident_id=resident.id
   WHERE organization_id=org AND property_id=prop AND id=rid;
  END IF;
  INSERT INTO atrium.service_events(organization_id,property_id,id,case_id,case_version,kind,actor_user_id,actor_session_id,request_id,created_at,note,state,priority,emergency_kinds,
  context_location_kind,context_unit_id,context_location_label,context_resident_id,context_resident_version,context_resident_name)
  VALUES(org,prop,gen_random_uuid(),rid,next_version,event_kind,actor,atrium.context('session_id')::uuid,p_input->>'requestId',stamp,note,state,priority,kinds,
  loc->>'kind',loc->>'unitId',loc->>'label',resident.id,resident.version,source_row.display_name);
 END IF;
 INSERT INTO atrium.service_commands(organization_id,property_id,actor_user_id,actor_credential_version,request_id,manifest,manifest_sha256,action,resource,resource_id,resource_version,configuration_version,committed_at)
 VALUES(org,prop,actor,atrium.context('credential_version')::bigint,p_input->>'requestId',p_input,digest,action,resource,rid,next_version,p_configuration,stamp);
 IF NOT atrium.hold_current_session() OR NOT atrium.can_access_property(org,prop,permission) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF action IN ('add_resident','review_resident') AND (src->>'validUntil')::timestamptz<=clock_timestamp()
 THEN RAISE EXCEPTION 'service_invalid_input' USING ERRCODE='P0001'; END IF;
 -- Time may advance while waiting for a lock; do not acknowledge stale planning authority.
 IF action='triage_request' AND state='ready_for_planning' AND request.location_kind='unit' AND request.request_origin<>'staff_observation' AND atrium.resident_context_state(resident) IS DISTINCT FROM 'current'
 THEN RAISE EXCEPTION 'service_context_required' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('requestId',p_input->>'requestId','action',action,'resource',resource,'id',rid,'version',next_version,'committedAt',atrium.service_iso(stamp),'replayed',false);
END $$;

GRANT USAGE,CREATE ON SCHEMA atrium TO atrium_resident_services_executor;
GRANT SELECT ON atrium.users,atrium.user_sessions,atrium.memberships,atrium.property_grants,atrium.organizations,atrium.properties,atrium.property_configurations,atrium.channel_bindings TO atrium_resident_services_executor;
GRANT UPDATE(id) ON atrium.properties TO atrium_resident_services_executor;
GRANT SELECT,INSERT ON atrium.organization_people,atrium.property_residents,atrium.resident_sources,atrium.resident_events,atrium.service_cases,atrium.service_events,atrium.service_commands TO atrium_resident_services_executor;
GRANT UPDATE ON atrium.property_residents,atrium.service_cases TO atrium_resident_services_executor;
GRANT SELECT ON atrium.organization_people,atrium.property_residents,atrium.resident_sources,atrium.resident_events,atrium.service_cases,atrium.service_events TO atrium_app;
GRANT EXECUTE ON FUNCTION atrium.context(text),atrium.staff_context(),atrium.channel_context(),atrium.session_context_valid(),atrium.mfa_login_allowed(),atrium.staff_property_permission(text,text,text),atrium.channel_property_permission(text,text,text),atrium.can_access_property(text,text,text),atrium.hold_current_session(),atrium.keep_workflow_evidence() TO atrium_resident_services_executor;
REVOKE ALL ON FUNCTION atrium.service_staff_context(),atrium.service_iso(timestamptz),atrium.resident_context_state(atrium.property_residents),atrium.resident_json(atrium.property_residents),atrium.service_case_json(atrium.service_cases),atrium.service_event_json(atrium.service_events),atrium.preserve_service_identity(),atrium.service_keys(jsonb,text[]),atrium.service_text(jsonb,integer,integer,boolean),atrium.service_id(jsonb),atrium.execute_resident_service(jsonb,bigint,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atrium.service_staff_context(),atrium.service_iso(timestamptz),atrium.resident_context_state(atrium.property_residents),atrium.resident_json(atrium.property_residents),atrium.service_case_json(atrium.service_cases),atrium.service_event_json(atrium.service_events) TO atrium_app,atrium_resident_services_executor;
GRANT EXECUTE ON FUNCTION atrium.preserve_service_identity(),atrium.service_keys(jsonb,text[]),atrium.service_text(jsonb,integer,integer,boolean),atrium.service_id(jsonb) TO atrium_resident_services_executor;
ALTER FUNCTION atrium.execute_resident_service(jsonb,bigint,text[]) OWNER TO atrium_resident_services_executor;
GRANT EXECUTE ON FUNCTION atrium.execute_resident_service(jsonb,bigint,text[]) TO atrium_app;
REVOKE CREATE ON SCHEMA atrium FROM atrium_resident_services_executor;
RESET ROLE;
