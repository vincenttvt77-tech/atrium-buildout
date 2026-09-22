-- Property-specific maintenance policy, vendor reviews and exact plan decisions.
-- Planning is not provider dispatch, resident verification, entry consent or an aggregate budget.
SET LOCAL ROLE atrium_admin;
CREATE TABLE atrium.maintenance_policies (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, version atrium.positive_version NOT NULL,
 published_by atrium.record_id NOT NULL REFERENCES atrium.users(id), published_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 currency text NOT NULL CHECK(currency='USD'),
 automatic_limit_cents bigint CHECK(automatic_limit_cents BETWEEN 0 AND 1000000000),
 manager_limit_cents bigint CHECK(manager_limit_cents BETWEEN 0 AND 1000000000),
 owner_limit_cents bigint NOT NULL CHECK(owner_limit_cents BETWEEN 0 AND 1000000000),
 automatic_categories text[] NOT NULL,
 excluded_categories text[] NOT NULL,
 require_resident_approval boolean NOT NULL,
 require_independent_approver boolean NOT NULL,
 source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 3 AND 240),
 observed_at timestamptz(3) NOT NULL,
 valid_until timestamptz(3) NOT NULL,
 PRIMARY KEY(organization_id,property_id,version), FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id),
 CHECK(automatic_limit_cents<=owner_limit_cents AND manager_limit_cents<=owner_limit_cents),
 CHECK(automatic_limit_cents IS NULL OR manager_limit_cents IS NULL OR automatic_limit_cents<=manager_limit_cents),
 CHECK(valid_until>observed_at AND valid_until-observed_at<=interval '8760 hours'),
 CHECK(automatic_limit_cents IS NOT NULL OR cardinality(automatic_categories)=0),
 CHECK(NOT automatic_categories && excluded_categories)
);
CREATE TABLE atrium.maintenance_vendors (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, version atrium.positive_version NOT NULL,
 reviewed_by atrium.record_id NOT NULL REFERENCES atrium.users(id), reviewed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
 categories text[] NOT NULL,
 status text NOT NULL CHECK(status IN ('approved','suspended')),
 phone text,
 email text,
 service_area text NOT NULL CHECK(length(service_area) BETWEEN 1 AND 500),
 hours text NOT NULL CHECK(length(hours) BETWEEN 1 AND 500),
 emergency_coverage boolean NOT NULL,
 availability text NOT NULL CHECK(availability IN ('unknown','available','unavailable')),
 availability_observed_at timestamptz(3),
 availability_valid_until timestamptz(3),
 expected_pricing text NOT NULL CHECK(length(expected_pricing)<=1000),
 response_target_minutes integer CHECK(response_target_minutes BETWEEN 1 AND 43200),
 preference integer NOT NULL CHECK(preference BETWEEN 0 AND 1000),
 restrictions text NOT NULL CHECK(length(restrictions)<=1000),
 source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 3 AND 240),
 observed_at timestamptz(3) NOT NULL,
 valid_until timestamptz(3) NOT NULL,
 PRIMARY KEY(organization_id,property_id,id,version), FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id),
 CHECK(valid_until>observed_at AND valid_until-observed_at<=interval '2160 hours'),
 CHECK(status<>'approved' OR phone IS NOT NULL OR email IS NOT NULL),
 CHECK((availability='unknown' AND availability_observed_at IS NULL AND availability_valid_until IS NULL) OR
  (availability<>'unknown' AND availability_observed_at IS NOT NULL AND availability_valid_until>availability_observed_at AND availability_valid_until-availability_observed_at<=interval '336 hours')),
 CHECK(phone IS NULL OR (length(phone) BETWEEN 6 AND 32 AND phone ~ '^\+?[0-9][0-9 ()-]{5,30}$')),
 CHECK(email IS NULL OR (length(email) BETWEEN 3 AND 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
);
CREATE TABLE atrium.maintenance_plans (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL, version atrium.positive_version NOT NULL,
 case_id uuid NOT NULL, case_version atrium.positive_version NOT NULL, configuration_version atrium.positive_version NOT NULL,
 resident_id uuid, resident_version atrium.positive_version, policy_version atrium.positive_version NOT NULL,
 prepared_by atrium.record_id NOT NULL REFERENCES atrium.users(id), prepared_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), withdrawn_at timestamptz(3), emergency_kinds text[] NOT NULL DEFAULT '{}' ,
 route text NOT NULL CHECK(route IN ('internal','vendor')),
 vendor_id uuid,
 vendor_version atrium.positive_version,
 internal_team text CHECK(length(internal_team) BETWEEN 1 AND 160),
 scope_of_work text NOT NULL CHECK(length(scope_of_work) BETWEEN 3 AND 4000),
 currency text NOT NULL CHECK(currency='USD'),
 maximum_cents bigint CHECK(maximum_cents BETWEEN 0 AND 1000000000),
 includes_all_charges boolean NOT NULL,
 access_requirement text NOT NULL CHECK(access_requirement IN ('no_unit_entry','unit_entry')),
 restrictions text[] NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 PRIMARY KEY(organization_id,property_id,id,version), UNIQUE(organization_id,property_id,case_id,version),
 FOREIGN KEY(organization_id,property_id,case_id) REFERENCES atrium.service_cases(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,resident_id) REFERENCES atrium.property_residents(organization_id,property_id,id),
 FOREIGN KEY(organization_id,property_id,policy_version) REFERENCES atrium.maintenance_policies(organization_id,property_id,version),
 FOREIGN KEY(organization_id,property_id,vendor_id,vendor_version) REFERENCES atrium.maintenance_vendors(organization_id,property_id,id,version),
 FOREIGN KEY(organization_id,property_id,configuration_version) REFERENCES atrium.property_configurations(organization_id,property_id,version),
 CHECK((resident_id IS NULL)=(resident_version IS NULL)),
 CHECK((route='internal' AND vendor_id IS NULL AND vendor_version IS NULL AND internal_team IS NOT NULL) OR
  (route='vendor' AND vendor_id IS NOT NULL AND vendor_version IS NOT NULL AND internal_team IS NULL)),
 CHECK(restrictions <@ ARRAY['legal','structural','safety_sensitive','unusual','other_restricted']::text[] AND array_position(restrictions,NULL) IS NULL),
 CHECK(emergency_kinds <@ ARRAY['gas','smoke_or_fire','carbon_monoxide','flooding','no_heat','injury','intruder','structural']::text[] AND array_position(emergency_kinds,NULL) IS NULL)
);
CREATE TABLE atrium.maintenance_decisions (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL,
 plan_id uuid NOT NULL, plan_version atrium.positive_version NOT NULL, decision text NOT NULL CHECK(decision IN ('approve','reject')),
 actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_credential_version atrium.positive_version NOT NULL,
 actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id), proof_id uuid NOT NULL REFERENCES atrium.mfa_assurances(id),
 actor_role text NOT NULL CHECK(actor_role IN ('owner','admin')), reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 decided_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,id), UNIQUE(organization_id,property_id,plan_id,plan_version),
 FOREIGN KEY(organization_id,property_id,plan_id,plan_version) REFERENCES atrium.maintenance_plans(organization_id,property_id,id,version)
);
CREATE TABLE atrium.maintenance_plan_events (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL, id uuid NOT NULL,
 plan_id uuid NOT NULL, plan_version atrium.positive_version NOT NULL, kind text NOT NULL CHECK(kind IN ('prepared','approved','rejected','withdrawn','safety_hold')),
 actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id),
 request_id atrium.record_id NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 PRIMARY KEY(organization_id,property_id,id), FOREIGN KEY(organization_id,property_id,plan_id,plan_version) REFERENCES atrium.maintenance_plans(organization_id,property_id,id,version)
);
CREATE TABLE atrium.maintenance_commands (
 organization_id atrium.record_id NOT NULL, property_id atrium.record_id NOT NULL,
 actor_user_id atrium.record_id NOT NULL REFERENCES atrium.users(id), actor_credential_version atrium.positive_version NOT NULL,
 actor_session_id uuid NOT NULL REFERENCES atrium.user_sessions(id), proof_id uuid REFERENCES atrium.mfa_assurances(id),
 request_id atrium.record_id NOT NULL, manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND pg_column_size(manifest)<=32768),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(action IN ('publish_policy','save_vendor','prepare_plan','decide_plan','withdraw_plan')),
 outcome text NOT NULL CHECK(outcome IN ('saved','emergency_held')),
 resource text NOT NULL CHECK(resource IN ('policy','vendor','plan')), resource_id text NOT NULL, resource_version atrium.positive_version NOT NULL,
 configuration_version atrium.positive_version NOT NULL, committed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,property_id,actor_user_id,request_id), FOREIGN KEY(organization_id,property_id) REFERENCES atrium.properties(organization_id,id)
);
ALTER TABLE atrium.maintenance_plan_events ADD FOREIGN KEY(organization_id,property_id,actor_user_id,request_id)
 REFERENCES atrium.maintenance_commands(organization_id,property_id,actor_user_id,request_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX maintenance_vendor_page ON atrium.maintenance_vendors(organization_id,property_id,created_at DESC,id DESC,version DESC);
CREATE INDEX maintenance_plan_case ON atrium.maintenance_plans(organization_id,property_id,case_id,version DESC);
CREATE INDEX maintenance_history_page ON atrium.maintenance_plan_events(organization_id,property_id,plan_id,created_at DESC,id DESC);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['maintenance_policies','maintenance_vendors','maintenance_plans','maintenance_decisions','maintenance_plan_events','maintenance_commands'] LOOP
  EXECUTE format('ALTER TABLE atrium.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE atrium.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY maintenance ON atrium.%I TO atrium_admin USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY staff_read ON atrium.%I FOR SELECT TO atrium_app,atrium_resident_services_executor USING(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id'') AND (SELECT atrium.service_staff_context() AND atrium.can_access_property(atrium.context(''organization_id''),atrium.context(''property_id''),''operate'')))',t);
  EXECUTE format('CREATE POLICY command_append ON atrium.%I FOR INSERT TO atrium_resident_services_executor WITH CHECK(organization_id=atrium.context(''organization_id'') AND property_id=atrium.context(''property_id''))',t);
  EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON atrium.%I FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['maintenance_policies','maintenance_vendors'] LOOP
  EXECUTE format('ALTER TABLE atrium.%I ADD CONSTRAINT categories_valid CHECK(%s)',t,
   CASE WHEN t='maintenance_policies' THEN 'automatic_categories <@ ARRAY[''plumbing'',''electrical'',''heating_cooling'',''appliance'',''pest'',''access'',''other'']::text[] AND excluded_categories <@ ARRAY[''plumbing'',''electrical'',''heating_cooling'',''appliance'',''pest'',''access'',''other'']::text[] AND array_position(automatic_categories,NULL) IS NULL AND array_position(excluded_categories,NULL) IS NULL'
   ELSE 'cardinality(categories)>0 AND categories <@ ARRAY[''plumbing'',''electrical'',''heating_cooling'',''appliance'',''pest'',''access'',''other'']::text[] AND array_position(categories,NULL) IS NULL' END);
 END LOOP;
END $$;

CREATE FUNCTION atrium.maintenance_policy_json(p atrium.maintenance_policies) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('organizationId',p.organization_id,
 'propertyId',p.property_id,
 'version',p.version,
 'publishedBy',p.published_by,
 'publishedAt',atrium.service_iso(p.published_at),
 'currency',p.currency,
 'automaticLimitCents',p.automatic_limit_cents,
 'managerLimitCents',p.manager_limit_cents,
 'ownerLimitCents',p.owner_limit_cents,
 'automaticCategories',p.automatic_categories,
 'excludedCategories',p.excluded_categories,
 'requireResidentApproval',p.require_resident_approval,
 'requireIndependentApprover',p.require_independent_approver,
 'sourceReference',p.source_reference,
 'observedAt',atrium.service_iso(p.observed_at),
 'validUntil',atrium.service_iso(p.valid_until))
$$;

CREATE FUNCTION atrium.maintenance_vendor_json(p atrium.maintenance_vendors) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('organizationId',p.organization_id,
 'propertyId',p.property_id,
 'version',p.version,
 'id',p.id,
 'reviewedBy',p.reviewed_by,
 'reviewedAt',atrium.service_iso(p.reviewed_at),
 'createdAt',atrium.service_iso(p.created_at),
 'name',p.name,
 'categories',p.categories,
 'status',p.status,
 'phone',p.phone,
 'email',p.email,
 'serviceArea',p.service_area,
 'hours',p.hours,
 'emergencyCoverage',p.emergency_coverage,
 'availability',p.availability,
 'availabilityObservedAt',atrium.service_iso(p.availability_observed_at),
 'availabilityValidUntil',atrium.service_iso(p.availability_valid_until),
 'expectedPricing',p.expected_pricing,
 'responseTargetMinutes',p.response_target_minutes,
 'preference',p.preference,
 'restrictions',p.restrictions,
 'sourceReference',p.source_reference,
 'observedAt',atrium.service_iso(p.observed_at),
 'validUntil',atrium.service_iso(p.valid_until))
$$;

CREATE FUNCTION atrium.maintenance_plan_json(p atrium.maintenance_plans) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('organizationId',p.organization_id,
 'propertyId',p.property_id,
 'version',p.version,
 'id',p.id,
 'caseId',p.case_id,
 'caseVersion',p.case_version,
 'configurationVersion',p.configuration_version,
 'residentId',p.resident_id,
 'residentVersion',p.resident_version,
 'policyVersion',p.policy_version,
 'preparedBy',p.prepared_by,
 'preparedAt',atrium.service_iso(p.prepared_at),
 'createdAt',atrium.service_iso(p.created_at),
 'withdrawnAt',atrium.service_iso(p.withdrawn_at),
 'emergencyKinds',p.emergency_kinds,
 'route',p.route,
 'vendorId',p.vendor_id,
 'vendorVersion',p.vendor_version,
 'internalTeam',p.internal_team,
 'scopeOfWork',p.scope_of_work,
 'currency',p.currency,
 'maximumCents',p.maximum_cents,
 'includesAllCharges',p.includes_all_charges,
 'accessRequirement',p.access_requirement,
 'restrictions',p.restrictions,
 'reason',p.reason)
$$;

CREATE FUNCTION atrium.maintenance_number(v jsonb,lo bigint,hi bigint,nullable boolean DEFAULT false) RETURNS boolean
 LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN v='null'::jsonb THEN nullable WHEN jsonb_typeof(v)='number' AND v#>>'{}' ~ '^[0-9]{1,16}$'
 THEN (v#>>'{}')::numeric BETWEEN lo AND hi ELSE false END
$$;
CREATE FUNCTION atrium.maintenance_choices(v jsonb,allowed text[],minimum integer DEFAULT 0) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a text[];
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)>cardinality(allowed) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v) x WHERE jsonb_typeof(x)<>'string') THEN RETURN false; END IF;
 SELECT array_agg(x) INTO a FROM jsonb_array_elements_text(v) x;
 a:=coalesce(a,'{}');
 RETURN cardinality(a)>=minimum AND a <@ allowed AND cardinality(a)=(SELECT count(DISTINCT x) FROM unnest(a) x);
END $$;
CREATE FUNCTION atrium.maintenance_timestamp(v jsonb,nullable boolean DEFAULT false) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF v='null'::jsonb THEN RETURN nullable; END IF;
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR v#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
 RETURN atrium.service_iso((v#>>'{}')::timestamptz)=v#>>'{}';
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION atrium.maintenance_uuid(v jsonb,nullable boolean DEFAULT false) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(CASE WHEN v='null'::jsonb THEN nullable ELSE jsonb_typeof(v)='string' AND v#>>'{}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' END,false)
$$;
CREATE FUNCTION atrium.maintenance_details_valid(kind text,d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE categories text[]:=ARRAY['plumbing','electrical','heating_cooling','appliance','pest','access','other'];
BEGIN
 IF kind='policy' THEN
  IF NOT coalesce(atrium.service_keys(d,ARRAY['currency','automaticLimitCents','managerLimitCents','ownerLimitCents','automaticCategories','excludedCategories','requireResidentApproval','requireIndependentApprover','sourceReference','observedAt','validUntil']),false) THEN RETURN false; END IF;
  IF NOT coalesce(atrium.service_text(d->'currency',1,100,false)
   AND atrium.maintenance_number(d->'automaticLimitCents',0,1000000000,true)
   AND atrium.maintenance_number(d->'managerLimitCents',0,1000000000,true)
   AND atrium.maintenance_number(d->'ownerLimitCents',0,1000000000,false)
   AND atrium.maintenance_choices(d->'automaticCategories',categories,0)
   AND atrium.maintenance_choices(d->'excludedCategories',categories,0)
   AND jsonb_typeof(d->'requireResidentApproval')='boolean'
   AND jsonb_typeof(d->'requireIndependentApprover')='boolean'
   AND atrium.service_text(d->'sourceReference',3,240,false)
   AND atrium.maintenance_timestamp(d->'observedAt',false)
   AND atrium.maintenance_timestamp(d->'validUntil',false),false) THEN RETURN false; END IF;
 END IF;
 IF kind='vendor' THEN
  IF NOT coalesce(atrium.service_keys(d,ARRAY['name','categories','status','phone','email','serviceArea','hours','emergencyCoverage','availability','availabilityObservedAt','availabilityValidUntil','expectedPricing','responseTargetMinutes','preference','restrictions','sourceReference','observedAt','validUntil']),false) THEN RETURN false; END IF;
  IF NOT coalesce(atrium.service_text(d->'name',1,160,false)
   AND atrium.maintenance_choices(d->'categories',categories,1)
   AND atrium.service_text(d->'status',1,100,false)
   AND atrium.service_text(d->'phone',1,32,true)
   AND atrium.service_text(d->'email',1,254,true)
   AND atrium.service_text(d->'serviceArea',1,500,false)
   AND atrium.service_text(d->'hours',1,500,false)
   AND jsonb_typeof(d->'emergencyCoverage')='boolean'
   AND atrium.service_text(d->'availability',1,100,false)
   AND atrium.maintenance_timestamp(d->'availabilityObservedAt',true)
   AND atrium.maintenance_timestamp(d->'availabilityValidUntil',true)
   AND atrium.service_text(d->'expectedPricing',0,1000,false)
   AND atrium.maintenance_number(d->'responseTargetMinutes',1,43200,true)
   AND atrium.maintenance_number(d->'preference',0,1000,false)
   AND atrium.service_text(d->'restrictions',0,1000,false)
   AND atrium.service_text(d->'sourceReference',3,240,false)
   AND atrium.maintenance_timestamp(d->'observedAt',false)
   AND atrium.maintenance_timestamp(d->'validUntil',false),false) THEN RETURN false; END IF;
 END IF;
 IF kind='plan' THEN
  IF NOT coalesce(atrium.service_keys(d,ARRAY['route','vendorId','vendorVersion','internalTeam','scopeOfWork','currency','maximumCents','includesAllCharges','accessRequirement','restrictions','reason']),false) THEN RETURN false; END IF;
  IF NOT coalesce(atrium.service_text(d->'route',1,100,false)
   AND atrium.maintenance_uuid(d->'vendorId',true)
   AND atrium.maintenance_number(d->'vendorVersion',1,9007199254740991,true)
   AND atrium.service_text(d->'internalTeam',1,160,true)
   AND atrium.service_text(d->'scopeOfWork',3,4000,false)
   AND atrium.service_text(d->'currency',1,100,false)
   AND atrium.maintenance_number(d->'maximumCents',0,1000000000,true)
   AND jsonb_typeof(d->'includesAllCharges')='boolean'
   AND atrium.service_text(d->'accessRequirement',1,100,false)
   AND atrium.maintenance_choices(d->'restrictions',ARRAY['legal','structural','safety_sensitive','unusual','other_restricted'],0)
   AND atrium.service_text(d->'reason',3,1000,false),false) THEN RETURN false; END IF;
 END IF;

 IF kind IN ('policy','vendor') THEN
  IF (d->>'validUntil')::timestamptz<=(d->>'observedAt')::timestamptz OR
   (d->>'validUntil')::timestamptz-(d->>'observedAt')::timestamptz>(CASE WHEN kind='policy' THEN interval '8760 hours' ELSE interval '2160 hours' END) THEN RETURN false; END IF;
 END IF;
 IF kind='policy' THEN
  RETURN d->>'currency'='USD' AND coalesce((d->>'automaticLimitCents')::bigint<=(d->>'ownerLimitCents')::bigint,true)
   AND coalesce((d->>'managerLimitCents')::bigint<=(d->>'ownerLimitCents')::bigint,true)
   AND coalesce((d->>'automaticLimitCents')::bigint<=(d->>'managerLimitCents')::bigint,true)
   AND (d->'automaticLimitCents'<>'null' OR jsonb_array_length(d->'automaticCategories')=0)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'automaticCategories') a WHERE d->'excludedCategories' @> jsonb_build_array(a));
 ELSIF kind='vendor' THEN
  RETURN d->>'status' IN ('approved','suspended') AND (d->>'status'<>'approved' OR d->>'phone' IS NOT NULL OR d->>'email' IS NOT NULL)
   AND (d->>'phone' IS NULL OR d->>'phone' ~ '^\+?[0-9][0-9 ()-]{5,30}$')
   AND (d->>'email' IS NULL OR d->>'email' ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
   AND ((d->>'availability'='unknown' AND d->'availabilityObservedAt'='null' AND d->'availabilityValidUntil'='null') OR
    (d->>'availability' IN ('available','unavailable') AND d->>'availabilityObservedAt' IS NOT NULL AND d->>'availabilityValidUntil' IS NOT NULL
      AND (d->>'availabilityValidUntil')::timestamptz>(d->>'availabilityObservedAt')::timestamptz
      AND (d->>'availabilityValidUntil')::timestamptz-(d->>'availabilityObservedAt')::timestamptz<=interval '336 hours'));
 ELSIF kind='plan' THEN
  RETURN d->>'currency'='USD' AND d->>'accessRequirement' IN ('no_unit_entry','unit_entry') AND
   ((d->>'route'='vendor' AND d->>'vendorId' IS NOT NULL AND d->>'vendorVersion' IS NOT NULL AND d->'internalTeam'='null') OR
    (d->>'route'='internal' AND d->'vendorId'='null' AND d->'vendorVersion'='null' AND d->>'internalTeam' IS NOT NULL));
 END IF;
 RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION atrium.maintenance_emergencies(words text) RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(array_agg(DISTINCT kind ORDER BY kind),'{}'::text[]) FROM (VALUES
 ('gas','\ysmell(?:s|ing)? (?:like )?gas\y'),
 ('gas','\ygas (?:leak|smell|odou?r)\y'),
 ('gas','\ysmell of gas\y'),
 ('smoke_or_fire','\ythere(?:''s| is) a fire\y'),
 ('smoke_or_fire','\yon fire\y'),
 ('smoke_or_fire','\yfire in (?:the|my)\y'),
 ('smoke_or_fire','\yflames?\y'),
 ('smoke_or_fire','\ythere(?:''s| is) smoke\y'),
 ('smoke_or_fire','\ysmoke (?:coming|everywhere|pouring|filling)\y'),
 ('smoke_or_fire','\yi (?:see|smell) smoke\y'),
 ('smoke_or_fire','\ysmell(?:s|ing)? (?:like )?(?:smoke|burning)\y'),
 ('smoke_or_fire','\ysomething(?:''s| is) burning\y'),
 ('smoke_or_fire','\y(?:fire|smoke) (?:alarm|detector)s? (?:is |are )?(?:going off|sounding|blaring)\y'),
 ('carbon_monoxide','\ycarbon monoxide\y'),
 ('carbon_monoxide','\yco (?:detector|alarm)\y'),
 ('carbon_monoxide','\yco2? alarm going off\y'),
 ('injury','\y(?:someone|somebody|he|she|they|i)(?:''s| is|''ve| have)? (?:been )?(?:hurt|injured|bleeding)\y'),
 ('injury','\yunconscious\y'),
 ('injury','\ynot breathing\y'),
 ('injury','\yheart attack\y'),
 ('injury','\yfell down\y'),
 ('injury','\ythere(?:''s| is) blood\y'),
 ('injury','\ycall an ambulance\y'),
 ('intruder','\y(?:break[- ]?in|broke in|breaking in)\y'),
 ('intruder','\yintruder\y'),
 ('intruder','\ysomeone(?:''s| is) in my (?:apartment|unit|home)\y'),
 ('intruder','\ybeing robbed\y'),
 ('flooding','\y(?:apartment|unit|bathroom|kitchen|basement|hallway|floor|place)\s+(?:is\s+)?flood(?:ing|ed)\y'),
 ('flooding','\yflooding in\y'),
 ('flooding','\yit(?:''s| is) flooding\y'),
 ('flooding','\ywater (?:is )?(?:everywhere|pouring|gushing|coming through|all over)\y'),
 ('flooding','\yceiling(?:''s| is)? (?:leaking|coming down)\y'),
 ('flooding','\yburst pipe\y'),
 ('flooding','\ypipe burst\y'),
 ('no_heat','\yno heat\y'),
 ('no_heat','\yheat(?:''s| is)? (?:out|not working|off)\y'),
 ('no_heat','\yfreezing in (?:here|my)\y'),
 ('structural','\yceiling (?:collapsed|caved)\y'),
 ('structural','\ywall(?:''s| is) cracking\y'),
 ('structural','\yfloor (?:gave way|collapsed)\y')) AS rules(kind,pattern) WHERE words ~* pattern
$$;

CREATE FUNCTION atrium.maintenance_restricted(words text) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT words ~* '\y(lawsuit|litigation|eviction|evict|asbestos|load[ -]bearing|structural (repair|alteration|damage)|legal (dispute|notice|action)|accommodation request)\y'
$$;
CREATE FUNCTION atrium.maintenance_actor_role() RETURNS text LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT m.role FROM atrium.memberships m WHERE m.organization_id=atrium.context('organization_id') AND m.user_id=atrium.context('actor_user_id') AND m.status='active'
$$;
-- Spending gates are independently recomputed inside the finite command after lock waits.
CREATE FUNCTION atrium.maintenance_approval_eligible(p atrium.maintenance_plans,c atrium.service_cases,
 r atrium.property_residents,pol atrium.maintenance_policies,v atrium.maintenance_vendors,config jsonb,actor_role text,words text) RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 RETURN coalesce(p.withdrawn_at IS NULL AND c.priority<>'emergency' AND c.state='ready_for_planning' AND cardinality(c.emergency_kinds)=0
 AND cardinality(p.emergency_kinds)=0 AND cardinality(atrium.maintenance_emergencies(words))=0 AND NOT atrium.maintenance_restricted(words)
 AND c.location_kind<>'unknown' AND (c.location_kind<>'unit' OR EXISTS(SELECT 1 FROM jsonb_array_elements(config->'inventory') u WHERE u->>'unitId'=c.unit_id))
 AND (c.location_kind<>'unit' OR c.request_origin='staff_observation' OR (r.id IS NOT NULL AND r.unit_id=c.unit_id AND atrium.resident_context_state(r)='current'))
 AND c.version=p.case_version AND r.id IS NOT DISTINCT FROM p.resident_id AND r.version IS NOT DISTINCT FROM p.resident_version
 AND pol.version=p.policy_version AND pol.observed_at<=clock_timestamp() AND pol.valid_until>clock_timestamp()
 AND cardinality(p.restrictions)=0 AND NOT c.category=ANY(pol.excluded_categories)
 AND p.currency=pol.currency AND p.maximum_cents IS NOT NULL AND p.includes_all_charges
 AND p.maximum_cents<=CASE WHEN actor_role='owner' THEN pol.owner_limit_cents WHEN actor_role='admin' THEN pol.manager_limit_cents ELSE NULL END
 AND (NOT pol.require_independent_approver OR p.prepared_by<>atrium.context('actor_user_id'))
 AND (p.route='internal' OR (v.id=p.vendor_id AND v.version=p.vendor_version AND v.status='approved'
  AND v.observed_at<=clock_timestamp() AND v.valid_until>clock_timestamp() AND c.category=ANY(v.categories))),false);
END $$;
CREATE FUNCTION atrium.execute_maintenance_planning(p_input jsonb,p_configuration bigint,p_proof uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE org text:=atrium.context('organization_id'); prop text:=atrium.context('property_id'); actor text:=atrium.context('actor_user_id');
 action text; permission text; actor_role text; d jsonb; config jsonb; prior atrium.maintenance_commands%ROWTYPE;
 pol atrium.maintenance_policies%ROWTYPE; vendor atrium.maintenance_vendors%ROWTYPE; plan atrium.maintenance_plans%ROWTYPE;
 request atrium.service_cases%ROWTYPE; resident atrium.property_residents%ROWTYPE;
 resource text; rid text; next_version bigint; expected bigint; stamp timestamptz(3); digest text; event_kind text; note text; words text; kinds text[];
 keys text[]; requires_proof boolean; outcome text:='saved';
BEGIN
 IF NOT coalesce(atrium.service_staff_context(),false) OR NOT atrium.hold_current_session() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR NOT atrium.service_id(p_input->'requestId') OR pg_column_size(p_input)>32768
 OR jsonb_typeof(p_input->'action') IS DISTINCT FROM 'string' OR p_configuration IS NULL OR p_configuration NOT BETWEEN 1 AND 9007199254740991
 THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
 action:=p_input->>'action';requires_proof:=action IN ('publish_policy','save_vendor','decide_plan');
 permission:=CASE WHEN requires_proof THEN 'configure' ELSE 'operate' END;
 IF NOT atrium.can_access_property(org,prop,permission) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF requires_proof AND (p_proof IS NULL OR NOT atrium.mfa_hold_proof(p_proof,'organization_administration')) THEN RAISE EXCEPTION 'planning_mfa_required' USING ERRCODE='P0001'; END IF;
 -- One property lock serializes all immutable aggregate revisions; service case commands
 -- take this same property before case/resident locks. No network IO is permitted here.
 SELECT cfg.configuration INTO config FROM atrium.properties p JOIN atrium.property_configurations cfg
 ON cfg.organization_id=p.organization_id AND cfg.property_id=p.id AND cfg.version=p.published_configuration_version
 WHERE p.organization_id=org AND p.id=prop AND cfg.version=p_configuration AND cfg.status='published' FOR UPDATE OF p;
 IF NOT FOUND THEN RAISE EXCEPTION 'property_configuration_changed' USING ERRCODE='P0001'; END IF;
 actor_role:=atrium.maintenance_actor_role();
 IF action='publish_policy' AND actor_role IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 digest:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
 SELECT * INTO prior FROM atrium.maintenance_commands WHERE organization_id=org AND property_id=prop AND actor_user_id=actor AND request_id=p_input->>'requestId';
 IF FOUND THEN
  IF prior.actor_credential_version::text IS DISTINCT FROM atrium.context('credential_version') OR prior.manifest<>p_input OR prior.manifest_sha256<>digest
   THEN RAISE EXCEPTION 'planning_request_conflict' USING ERRCODE='P0001'; END IF;
  IF NOT atrium.hold_current_session() OR NOT atrium.can_access_property(org,prop,permission) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF requires_proof AND NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'planning_mfa_required' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('requestId',prior.request_id,'action',prior.action,'resource',prior.resource,'id',prior.resource_id,'version',prior.resource_version,'committedAt',atrium.service_iso(prior.committed_at),'outcome',prior.outcome,'replayed',true);
 END IF;
 keys:=CASE action WHEN 'publish_policy' THEN ARRAY['action','requestId','expectedVersion','details','reason']
 WHEN 'save_vendor' THEN ARRAY['action','requestId','id','expectedVersion','details','reason']
 WHEN 'prepare_plan' THEN ARRAY['action','requestId','caseId','expectedCaseVersion','expectedPlanVersion','policyVersion','details']
 WHEN 'decide_plan' THEN ARRAY['action','requestId','caseId','planId','expectedPlanVersion','decision','reason']
 WHEN 'withdraw_plan' THEN ARRAY['action','requestId','caseId','planId','expectedPlanVersion','reason'] END;
 IF keys IS NULL OR NOT coalesce(atrium.service_keys(p_input,keys),false) THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
 IF action<>'prepare_plan' AND NOT atrium.service_text(p_input->'reason',3,1000) THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
 SELECT * INTO pol FROM atrium.maintenance_policies WHERE organization_id=org AND property_id=prop ORDER BY version DESC LIMIT 1;
 stamp:=clock_timestamp();note:=p_input->>'reason';
 IF action IN ('publish_policy','save_vendor') THEN
  d:=p_input->'details';
  IF NOT atrium.maintenance_number(p_input->'expectedVersion',0,9007199254740991) OR
   NOT coalesce(atrium.maintenance_details_valid(CASE WHEN action='publish_policy' THEN 'policy' ELSE 'vendor' END,d),false)
   THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
  expected:=(p_input->>'expectedVersion')::bigint;
  IF (d->>'observedAt')::timestamptz>clock_timestamp() OR ((action='publish_policy' OR d->>'status'='approved') AND (d->>'validUntil')::timestamptz<=clock_timestamp())
   OR (action='save_vendor' AND d->>'availability'<>'unknown' AND ((d->>'availabilityObservedAt')::timestamptz>clock_timestamp() OR (d->>'availabilityValidUntil')::timestamptz<=clock_timestamp()))
   THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
  IF action='publish_policy' THEN
   IF coalesce(pol.version,0)<>expected THEN RAISE EXCEPTION 'planning_version_conflict' USING ERRCODE='P0001'; END IF;
   resource:='policy';rid:=prop;next_version:=expected+1;
   INSERT INTO atrium.maintenance_policies(organization_id,property_id,version,published_by,published_at,currency,automatic_limit_cents,manager_limit_cents,owner_limit_cents,automatic_categories,excluded_categories,require_resident_approval,require_independent_approver,source_reference,observed_at,valid_until)
   VALUES(org,prop,next_version,actor,stamp,d->>'currency',(d->>'automaticLimitCents')::bigint,(d->>'managerLimitCents')::bigint,(d->>'ownerLimitCents')::bigint,ARRAY(SELECT jsonb_array_elements_text(d->'automaticCategories')),ARRAY(SELECT jsonb_array_elements_text(d->'excludedCategories')),(d->>'requireResidentApproval')::boolean,(d->>'requireIndependentApprover')::boolean,d->>'sourceReference',(d->>'observedAt')::timestamptz,(d->>'validUntil')::timestamptz);

  ELSE
   IF NOT atrium.maintenance_uuid(p_input->'id',true) OR ((p_input->>'id' IS NULL)<>(expected=0)) THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
   IF expected>0 THEN
    SELECT * INTO vendor FROM atrium.maintenance_vendors WHERE organization_id=org AND property_id=prop AND id=(p_input->>'id')::uuid ORDER BY version DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'planning_not_found' USING ERRCODE='P0001'; END IF;
   END IF;
   IF coalesce(vendor.version,0)<>expected THEN RAISE EXCEPTION 'planning_version_conflict' USING ERRCODE='P0001'; END IF;
   resource:='vendor';rid:=coalesce(vendor.id,gen_random_uuid())::text;next_version:=expected+1;
   INSERT INTO atrium.maintenance_vendors(organization_id,property_id,id,version,reviewed_by,reviewed_at,created_at,name,categories,status,phone,email,service_area,hours,emergency_coverage,availability,availability_observed_at,availability_valid_until,expected_pricing,response_target_minutes,preference,restrictions,source_reference,observed_at,valid_until)
   VALUES(org,prop,rid::uuid,next_version,actor,stamp,coalesce(vendor.created_at,stamp),d->>'name',ARRAY(SELECT jsonb_array_elements_text(d->'categories')),d->>'status',d->>'phone',d->>'email',d->>'serviceArea',d->>'hours',(d->>'emergencyCoverage')::boolean,d->>'availability',(d->>'availabilityObservedAt')::timestamptz,(d->>'availabilityValidUntil')::timestamptz,d->>'expectedPricing',(d->>'responseTargetMinutes')::integer,(d->>'preference')::integer,d->>'restrictions',d->>'sourceReference',(d->>'observedAt')::timestamptz,(d->>'validUntil')::timestamptz);

  END IF;
 ELSE
  IF NOT atrium.maintenance_uuid(p_input->'caseId') OR NOT atrium.maintenance_number(p_input->'expectedPlanVersion',0,9007199254740991)
   THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
  SELECT * INTO request FROM atrium.service_cases WHERE organization_id=org AND property_id=prop AND id=(p_input->>'caseId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_not_found' USING ERRCODE='P0001'; END IF;
  IF request.resident_id IS NOT NULL THEN
   SELECT * INTO resident FROM atrium.property_residents WHERE organization_id=org AND property_id=prop AND id=request.resident_id FOR SHARE;
  END IF;
  SELECT * INTO plan FROM atrium.maintenance_plans WHERE organization_id=org AND property_id=prop AND case_id=request.id ORDER BY version DESC LIMIT 1;
  expected:=(p_input->>'expectedPlanVersion')::bigint;
  IF coalesce(plan.version,0)<>expected THEN RAISE EXCEPTION 'planning_version_conflict' USING ERRCODE='P0001'; END IF;
  resource:='plan';rid:=coalesce(plan.id,gen_random_uuid())::text;next_version:=expected;
  IF action='prepare_plan' THEN
   IF NOT atrium.maintenance_number(p_input->'expectedCaseVersion',1,9007199254740991) OR NOT atrium.maintenance_number(p_input->'policyVersion',1,9007199254740991)
    OR NOT coalesce(atrium.maintenance_details_valid('plan',p_input->'details'),false) THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
   IF request.version<>(p_input->>'expectedCaseVersion')::bigint OR pol.version IS DISTINCT FROM (p_input->>'policyVersion')::bigint
    THEN RAISE EXCEPTION 'planning_version_conflict' USING ERRCODE='P0001'; END IF;
   IF pol.valid_until<=clock_timestamp() OR pol.observed_at>clock_timestamp() THEN RAISE EXCEPTION 'planning_not_ready' USING ERRCODE='P0001'; END IF;
   d:=p_input->'details';note:=d->>'reason';event_kind:='prepared';next_version:=expected+1;
   IF d->>'route'='vendor' THEN
    SELECT * INTO vendor FROM atrium.maintenance_vendors WHERE organization_id=org AND property_id=prop AND id=(d->>'vendorId')::uuid ORDER BY version DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'planning_not_found' USING ERRCODE='P0001'; END IF;
    IF vendor.version<>(d->>'vendorVersion')::bigint THEN RAISE EXCEPTION 'planning_version_conflict' USING ERRCODE='P0001'; END IF;
   END IF;
   -- Earlier reported hazards survive revisions and rejected decisions; no ordinary edit clears them.
   SELECT coalesce(array_agg(DISTINCT k ORDER BY k),'{}'::text[]) INTO kinds FROM unnest(coalesce(plan.emergency_kinds,'{}')||
    atrium.maintenance_emergencies(concat_ws(E'\n',request.summary,request.description,request.access_notes,d->>'scopeOfWork',note,
      (SELECT string_agg(reason,E'\n') FROM atrium.maintenance_decisions WHERE organization_id=org AND property_id=prop AND plan_id=plan.id)))) k;
   IF cardinality(kinds)>0 THEN outcome:='emergency_held'; END IF;
   INSERT INTO atrium.maintenance_plans(organization_id,property_id,id,version,case_id,case_version,configuration_version,resident_id,resident_version,policy_version,prepared_by,prepared_at,created_at,emergency_kinds,route,vendor_id,vendor_version,internal_team,scope_of_work,currency,maximum_cents,includes_all_charges,access_requirement,restrictions,reason)
   VALUES(org,prop,rid::uuid,next_version,request.id,request.version,p_configuration,resident.id,resident.version,pol.version,actor,stamp,coalesce(plan.created_at,stamp),kinds,d->>'route',(d->>'vendorId')::uuid,(d->>'vendorVersion')::bigint,d->>'internalTeam',d->>'scopeOfWork',d->>'currency',(d->>'maximumCents')::bigint,(d->>'includesAllCharges')::boolean,d->>'accessRequirement',ARRAY(SELECT jsonb_array_elements_text(d->'restrictions')),d->>'reason');

  ELSE
   IF NOT atrium.maintenance_uuid(p_input->'planId') OR expected=0 OR plan.id IS DISTINCT FROM (p_input->>'planId')::uuid THEN RAISE EXCEPTION 'planning_not_found' USING ERRCODE='P0001'; END IF;
   IF plan.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'planning_version_conflict' USING ERRCODE='P0001'; END IF;
   IF action='withdraw_plan' THEN
    next_version:=expected+1;event_kind:='withdrawn';
    SELECT coalesce(array_agg(DISTINCT k ORDER BY k),'{}'::text[]) INTO kinds FROM unnest(plan.emergency_kinds||atrium.maintenance_emergencies(concat_ws(E'\n',note,(SELECT string_agg(reason,E'\n') FROM atrium.maintenance_decisions WHERE organization_id=org AND property_id=prop AND plan_id=plan.id)))) k;
    INSERT INTO atrium.maintenance_plans SELECT (jsonb_populate_record(NULL::atrium.maintenance_plans,to_jsonb(plan)||
      jsonb_build_object('version',next_version,'withdrawn_at',stamp,'emergency_kinds',kinds))).*;
   ELSE
    IF jsonb_typeof(p_input->'decision') IS DISTINCT FROM 'string' OR p_input->>'decision' NOT IN ('approve','reject') THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM atrium.maintenance_decisions WHERE organization_id=org AND property_id=prop AND plan_id=plan.id AND plan_version=plan.version)
     THEN RAISE EXCEPTION 'planning_version_conflict' USING ERRCODE='P0001'; END IF;
    IF plan.vendor_id IS NOT NULL THEN SELECT * INTO vendor FROM atrium.maintenance_vendors WHERE organization_id=org AND property_id=prop AND id=plan.vendor_id ORDER BY version DESC LIMIT 1; END IF;
    words:=concat_ws(E'\n',request.summary,request.description,request.access_notes,plan.scope_of_work,plan.reason,note);
    IF p_input->>'decision'='approve' AND cardinality(atrium.maintenance_emergencies(note))>0 THEN
     next_version:=expected+1;event_kind:='safety_hold';outcome:='emergency_held';
     SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(plan.emergency_kinds||atrium.maintenance_emergencies(concat_ws(E'\n',note,(SELECT string_agg(reason,E'\n') FROM atrium.maintenance_decisions WHERE organization_id=org AND property_id=prop AND plan_id=plan.id)))) k;
     INSERT INTO atrium.maintenance_plans SELECT (jsonb_populate_record(NULL::atrium.maintenance_plans,to_jsonb(plan)||
      jsonb_build_object('version',next_version,'emergency_kinds',kinds))).*;
    ELSE
    IF p_input->>'decision'='approve' AND (plan.configuration_version<>p_configuration OR NOT atrium.maintenance_approval_eligible(plan,request,resident,pol,vendor,config,actor_role,words))
     THEN RAISE EXCEPTION 'planning_not_ready' USING ERRCODE='P0001'; END IF;
    event_kind:=CASE WHEN p_input->>'decision'='approve' THEN 'approved' ELSE 'rejected' END;
    INSERT INTO atrium.maintenance_decisions(organization_id,property_id,id,plan_id,plan_version,decision,actor_user_id,actor_credential_version,actor_session_id,proof_id,actor_role,reason,decided_at)
     VALUES(org,prop,gen_random_uuid(),plan.id,plan.version,p_input->>'decision',actor,atrium.context('credential_version')::bigint,atrium.context('session_id')::uuid,p_proof,actor_role,note,stamp);
    END IF;
   END IF;
  END IF;
  INSERT INTO atrium.maintenance_plan_events(organization_id,property_id,id,plan_id,plan_version,kind,actor_user_id,actor_session_id,request_id,created_at,reason)
   VALUES(org,prop,gen_random_uuid(),rid::uuid,next_version,event_kind,actor,atrium.context('session_id')::uuid,p_input->>'requestId',stamp,note);
 END IF;
 INSERT INTO atrium.maintenance_commands(organization_id,property_id,actor_user_id,actor_credential_version,actor_session_id,proof_id,request_id,manifest,manifest_sha256,action,resource,resource_id,resource_version,configuration_version,committed_at,outcome)
 VALUES(org,prop,actor,atrium.context('credential_version')::bigint,atrium.context('session_id')::uuid,CASE WHEN requires_proof THEN p_proof ELSE NULL END,p_input->>'requestId',p_input,digest,action,resource,rid,next_version,p_configuration,stamp,outcome);
 -- Authorization, source freshness and proof are rechecked after audit insertion may wait.
 IF NOT atrium.hold_current_session() OR NOT atrium.can_access_property(org,prop,permission) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 actor_role:=atrium.maintenance_actor_role();
 IF action='publish_policy' AND actor_role IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF requires_proof AND NOT atrium.mfa_hold_proof(p_proof,'organization_administration') THEN RAISE EXCEPTION 'planning_mfa_required' USING ERRCODE='P0001'; END IF;
 IF action IN ('publish_policy','save_vendor') AND ((action='publish_policy' OR d->>'status'='approved') AND (d->>'validUntil')::timestamptz<=clock_timestamp()
   OR action='save_vendor' AND d->>'availability'<>'unknown' AND (d->>'availabilityValidUntil')::timestamptz<=clock_timestamp())
  THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='P0001'; END IF;
 IF action='prepare_plan' AND pol.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'planning_not_ready' USING ERRCODE='P0001'; END IF;
 IF action='decide_plan' AND outcome='saved' AND p_input->>'decision'='approve' AND NOT atrium.maintenance_approval_eligible(plan,request,resident,pol,vendor,config,actor_role,words)
  THEN RAISE EXCEPTION 'planning_not_ready' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('requestId',p_input->>'requestId','action',action,'resource',resource,'id',rid,'version',next_version,'committedAt',atrium.service_iso(stamp),'outcome',outcome,'replayed',false);
END $$;

-- This finite reader sees scoped membership facts, never credentials, names or contacts.
-- Its RLS leaves do not depend on the decisions helper, avoiding recursive authorization.
CREATE POLICY planning_reader_membership ON atrium.memberships FOR SELECT TO atrium_maintenance_approval_reader
 USING(organization_id=atrium.context('organization_id'));
CREATE POLICY planning_reader_user ON atrium.users FOR SELECT TO atrium_maintenance_approval_reader
 USING(EXISTS(SELECT 1 FROM atrium.memberships m WHERE m.organization_id=atrium.context('organization_id') AND m.user_id=users.id));
CREATE POLICY planning_reader_grant ON atrium.property_grants FOR SELECT TO atrium_maintenance_approval_reader
 USING(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id'));
CREATE POLICY planning_reader_session ON atrium.user_sessions FOR SELECT TO atrium_maintenance_approval_reader
 USING(user_id=atrium.context('actor_user_id') AND id::text=atrium.context('session_id') AND credential_version::text=atrium.context('credential_version'));
CREATE POLICY planning_reader_organization ON atrium.organizations FOR SELECT TO atrium_maintenance_approval_reader USING(id=atrium.context('organization_id'));
CREATE POLICY planning_reader_property ON atrium.properties FOR SELECT TO atrium_maintenance_approval_reader
 USING(organization_id=atrium.context('organization_id') AND id=atrium.context('property_id'));
CREATE POLICY planning_reader_no_channel ON atrium.channel_bindings FOR SELECT TO atrium_maintenance_approval_reader USING(false);
CREATE POLICY planning_reader_decision ON atrium.maintenance_decisions FOR SELECT TO atrium_maintenance_approval_reader
 USING(organization_id=atrium.context('organization_id') AND property_id=atrium.context('property_id'));
CREATE FUNCTION atrium.maintenance_decision_authority(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE role_now text;
BEGIN
 IF NOT coalesce(atrium.service_staff_context() AND atrium.can_access_property(atrium.context('organization_id'),atrium.context('property_id'),'operate'),false)
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 SELECT m.role INTO role_now FROM atrium.maintenance_decisions d
 JOIN atrium.users u ON u.id=d.actor_user_id AND u.status='active'
 JOIN atrium.memberships m ON m.user_id=d.actor_user_id AND m.organization_id=d.organization_id AND m.status='active' AND m.role IN ('owner','admin')
 JOIN atrium.organizations o ON o.id=m.organization_id AND o.status='active'
 JOIN atrium.properties p ON p.organization_id=d.organization_id AND p.id=d.property_id AND p.status='active'
 WHERE d.organization_id=atrium.context('organization_id') AND d.property_id=atrium.context('property_id') AND d.id=p_id
 AND (m.access='organization' OR EXISTS(SELECT 1 FROM atrium.property_grants g WHERE g.organization_id=d.organization_id AND g.property_id=d.property_id AND g.membership_id=m.id AND g.status='active'));
 IF NOT coalesce(atrium.service_staff_context() AND atrium.can_access_property(atrium.context('organization_id'),atrium.context('property_id'),'operate'),false)
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('currentRole',role_now,'authorityCurrent',role_now IS NOT NULL);
END $$;
GRANT USAGE,CREATE ON SCHEMA atrium TO atrium_maintenance_approval_reader,atrium_resident_services_executor;
GRANT SELECT(id,status,credential_version) ON atrium.users TO atrium_maintenance_approval_reader;
GRANT SELECT(id,user_id,organization_id,status,role,access) ON atrium.memberships TO atrium_maintenance_approval_reader;
GRANT SELECT(membership_id,organization_id,property_id,status) ON atrium.property_grants TO atrium_maintenance_approval_reader;
GRANT SELECT(id,user_id,credential_version,revoked_at_ms,expires_at_ms) ON atrium.user_sessions TO atrium_maintenance_approval_reader;
GRANT SELECT(id,status) ON atrium.organizations TO atrium_maintenance_approval_reader;
GRANT SELECT(id,organization_id,status) ON atrium.properties TO atrium_maintenance_approval_reader;
GRANT SELECT(id,organization_id,property_id,status,permission_version,capabilities) ON atrium.channel_bindings TO atrium_maintenance_approval_reader;
GRANT SELECT(id,organization_id,property_id,actor_user_id) ON atrium.maintenance_decisions TO atrium_maintenance_approval_reader;
GRANT EXECUTE ON FUNCTION atrium.context(text),atrium.service_staff_context(),atrium.staff_context(),atrium.channel_context(),atrium.session_context_valid(),atrium.mfa_login_allowed(),atrium.staff_property_permission(text,text,text),atrium.channel_property_permission(text,text,text),atrium.can_access_property(text,text,text) TO atrium_maintenance_approval_reader;
GRANT EXECUTE ON FUNCTION atrium.mfa_hold_proof(uuid,text) TO atrium_resident_services_executor;
DO $$ DECLARE t text; f regprocedure; BEGIN
 FOREACH t IN ARRAY ARRAY['maintenance_policies','maintenance_vendors','maintenance_plans','maintenance_decisions','maintenance_plan_events','maintenance_commands'] LOOP
  EXECUTE format('GRANT SELECT,INSERT ON atrium.%I TO atrium_resident_services_executor',t);
  IF t<>'maintenance_commands' THEN EXECUTE format('GRANT SELECT ON atrium.%I TO atrium_app',t); END IF;
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='atrium'
 AND (p.proname LIKE 'maintenance_%' OR p.proname='execute_maintenance_planning') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO atrium_resident_services_executor',f);
 END LOOP;
END $$;
ALTER FUNCTION atrium.execute_maintenance_planning(jsonb,bigint,uuid) OWNER TO atrium_resident_services_executor;
ALTER FUNCTION atrium.maintenance_decision_authority(uuid) OWNER TO atrium_maintenance_approval_reader;
GRANT EXECUTE ON FUNCTION atrium.execute_maintenance_planning(jsonb,bigint,uuid),atrium.maintenance_decision_authority(uuid),atrium.maintenance_policy_json(atrium.maintenance_policies),atrium.maintenance_vendor_json(atrium.maintenance_vendors),atrium.maintenance_plan_json(atrium.maintenance_plans),atrium.maintenance_actor_role() TO atrium_app;
REVOKE CREATE ON SCHEMA atrium FROM atrium_maintenance_approval_reader,atrium_resident_services_executor;
RESET ROLE;
