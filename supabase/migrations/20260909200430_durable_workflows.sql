-- Durable workflow metadata. Runtime workers retain ordinary property-scoped rights.
-- This source is copied only into its newly generated migration, never a prior version.
SET LOCAL ROLE atrium_admin;

CREATE TABLE atrium.inbox_events (
  organization_id atrium.record_id NOT NULL,
  property_id atrium.record_id NOT NULL,
  id atrium.record_id NOT NULL,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 256 AND event_id !~ '[[:cntrl:]]'),
  origin_kind text NOT NULL CHECK (origin_kind IN ('user', 'channel')),
  origin_user_id atrium.record_id REFERENCES atrium.users(id),
  origin_credential_version atrium.positive_version,
  origin_binding_id atrium.record_id,
  origin_binding_version atrium.positive_version,
  origin_provider text,
  origin_external_id text,
  origin_key text GENERATED ALWAYS AS
    (CASE WHEN origin_kind = 'user' THEN 'user:' || origin_user_id ELSE 'channel:' || origin_binding_id END) STORED,
  configuration_version atrium.positive_version NOT NULL,
  request_id atrium.record_id NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  -- The accepted action manifest is evidence for receipt replay, not mutable job state.
  action_manifest jsonb NOT NULL CHECK (jsonb_typeof(action_manifest) = 'array'
    AND jsonb_array_length(action_manifest) BETWEEN 1 AND 20),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, property_id, id),
  UNIQUE (organization_id, property_id, origin_key, source, event_id),
  FOREIGN KEY (organization_id, property_id) REFERENCES atrium.properties(organization_id, id),
  FOREIGN KEY (organization_id, property_id, origin_binding_id)
    REFERENCES atrium.channel_bindings(organization_id, property_id, id),
  FOREIGN KEY (organization_id, property_id, configuration_version)
    REFERENCES atrium.property_configurations(organization_id, property_id, version),
  CHECK ((origin_kind = 'user' AND origin_user_id IS NOT NULL AND origin_credential_version IS NOT NULL
      AND origin_binding_id IS NULL AND origin_binding_version IS NULL AND origin_provider IS NULL AND origin_external_id IS NULL)
    OR (origin_kind = 'channel' AND origin_user_id IS NULL AND origin_credential_version IS NULL
      AND origin_binding_id IS NOT NULL AND origin_binding_version IS NOT NULL
      AND origin_provider IS NOT NULL AND origin_provider ~ '^[a-z][a-z0-9_-]{0,63}$'
      AND origin_external_id IS NOT NULL AND length(origin_external_id) BETWEEN 1 AND 256
      AND origin_external_id !~ '[[:space:][:cntrl:]]'))
);
CREATE INDEX inbox_events_configuration_idx ON atrium.inbox_events (organization_id, property_id, configuration_version);
CREATE INDEX inbox_events_origin_user_idx ON atrium.inbox_events (origin_user_id) WHERE origin_user_id IS NOT NULL;
CREATE INDEX inbox_events_origin_binding_idx ON atrium.inbox_events (organization_id, property_id, origin_binding_id);

CREATE TABLE atrium.action_intents (
  organization_id atrium.record_id NOT NULL,
  property_id atrium.record_id NOT NULL,
  id atrium.record_id NOT NULL,
  receipt_id atrium.record_id NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  connector text NOT NULL CHECK (connector ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  source_operation_key text NOT NULL CHECK (length(source_operation_key) BETWEEN 1 AND 256 AND source_operation_key !~ '[[:cntrl:]]'),
  operation_key text NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, property_id, id),
  UNIQUE (organization_id, property_id, connector, kind, source_operation_key),
  UNIQUE (operation_key),
  FOREIGN KEY (organization_id, property_id, receipt_id)
    REFERENCES atrium.inbox_events(organization_id, property_id, id)
);
CREATE INDEX action_intents_receipt_idx ON atrium.action_intents (organization_id, property_id, receipt_id);
CREATE INDEX action_intents_page_idx ON atrium.action_intents (organization_id, property_id, created_at DESC, id DESC);

CREATE TABLE atrium.outbox_messages (
  organization_id atrium.record_id NOT NULL,
  property_id atrium.record_id NOT NULL,
  action_id atrium.record_id NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','retry_wait','verifying','succeeded','needs_review','cancelled')),
  phase text NOT NULL DEFAULT 'dispatch' CHECK (phase IN ('dispatch','verify')),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts BETWEEN 0 AND 10),
  verification_attempts bigint NOT NULL DEFAULT 0 CHECK (verification_attempts BETWEEN 0 AND 9007199254740991),
  verification_attempts_at_replay bigint NOT NULL DEFAULT 0 CHECK (verification_attempts_at_replay BETWEEN 0 AND verification_attempts),
  available_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz(3),
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,127}$'),
  dispatch_started boolean NOT NULL DEFAULT false,
  safe_retry_evidence text CHECK (safe_retry_evidence IN ('rejected_before_effect','authoritative_absence_idempotent')),
  provider_reference text CHECK (length(provider_reference) BETWEEN 1 AND 512 AND provider_reference !~ '[[:cntrl:]]'),
  evidence jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  lease_token uuid,
  worker_id text CHECK (length(worker_id) BETWEEN 1 AND 128 AND worker_id !~ '[[:cntrl:]]'),
  lease_acquired_at timestamptz(3),
  lease_expires_at timestamptz(3),
  PRIMARY KEY (organization_id, property_id, action_id),
  FOREIGN KEY (organization_id, property_id, action_id)
    REFERENCES atrium.action_intents(organization_id, property_id, id),
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND worker_id IS NOT NULL
      AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL
      AND lease_expires_at > lease_acquired_at AND lease_expires_at <= lease_acquired_at + interval '15 minutes')
    OR (state <> 'running' AND lease_token IS NULL AND worker_id IS NULL
      AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)),
  CHECK ((state IN ('succeeded','needs_review','cancelled')) = (completed_at IS NOT NULL)),
  CHECK (state <> 'succeeded' OR (dispatch_started AND phase = 'verify' AND evidence IS NOT NULL AND provider_reference IS NOT NULL)),
  CHECK (state <> 'cancelled' OR NOT dispatch_started),
  CHECK (state <> 'verifying' OR phase = 'verify'),
  CHECK (phase <> 'verify' OR dispatch_started),
  CHECK (NOT dispatch_started OR phase <> 'dispatch' OR safe_retry_evidence IS NOT NULL),
  CHECK (safe_retry_evidence IS NULL OR (dispatch_started AND phase = 'dispatch'))
);
CREATE INDEX outbox_messages_due_idx ON atrium.outbox_messages (organization_id, property_id, available_at, action_id)
  WHERE state IN ('queued','retry_wait','verifying');
CREATE INDEX outbox_messages_expired_idx ON atrium.outbox_messages (organization_id, property_id, lease_expires_at, action_id)
  WHERE state = 'running';

CREATE TABLE atrium.workflow_events (
  organization_id atrium.record_id NOT NULL,
  property_id atrium.record_id NOT NULL,
  id atrium.record_id NOT NULL,
  action_id atrium.record_id NOT NULL,
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_]{0,127}$'),
  actor_user_id atrium.record_id REFERENCES atrium.users(id),
  actor_channel_binding_id atrium.record_id,
  request_id atrium.record_id NOT NULL,
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, property_id, id),
  FOREIGN KEY (organization_id, property_id, action_id)
    REFERENCES atrium.action_intents(organization_id, property_id, id),
  FOREIGN KEY (organization_id, property_id, actor_channel_binding_id)
    REFERENCES atrium.channel_bindings(organization_id, property_id, id),
  CHECK (num_nonnulls(actor_user_id, actor_channel_binding_id) = 1)
);
CREATE INDEX workflow_events_action_idx ON atrium.workflow_events (organization_id, property_id, action_id, created_at, id);
CREATE INDEX workflow_events_actor_user_idx ON atrium.workflow_events (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX workflow_events_actor_binding_idx ON atrium.workflow_events (organization_id, property_id, actor_channel_binding_id);

CREATE FUNCTION atrium.keep_workflow_evidence() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Workflow ownership, keys, payloads and evidence are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_inbox BEFORE UPDATE OR DELETE ON atrium.inbox_events
  FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence();
CREATE TRIGGER immutable_action BEFORE UPDATE OR DELETE ON atrium.action_intents
  FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence();
CREATE TRIGGER immutable_workflow_event BEFORE UPDATE OR DELETE ON atrium.workflow_events
  FOR EACH ROW EXECUTE FUNCTION atrium.keep_workflow_evidence();

CREATE FUNCTION atrium.keep_outbox_identity() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Workflow jobs must be retained' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.organization_id, NEW.property_id, NEW.action_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.organization_id, OLD.property_id, OLD.action_id, OLD.created_at)
    OR (OLD.dispatch_started AND NOT NEW.dispatch_started)
    OR NEW.dispatch_attempts < OLD.dispatch_attempts OR NEW.verification_attempts < OLD.verification_attempts THEN
    RAISE EXCEPTION 'Workflow ownership and attempt history are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.verification_attempts_at_replay IS DISTINCT FROM OLD.verification_attempts_at_replay
    AND (NEW.verification_attempts_at_replay <> OLD.verification_attempts
      OR NOT atrium.can_access_property(OLD.organization_id,OLD.property_id,'configure')) THEN
    RAISE EXCEPTION 'Only an authorized operator replay can renew verification attempts' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_outbox_identity BEFORE UPDATE OR DELETE ON atrium.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION atrium.keep_outbox_identity();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['inbox_events','action_intents','outbox_messages','workflow_events'] LOOP
    EXECUTE format('ALTER TABLE atrium.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE atrium.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY maintenance ON atrium.%I TO atrium_admin USING (true) WITH CHECK (true)', table_name);
    EXECUTE format('CREATE POLICY scoped_read ON atrium.%I FOR SELECT TO atrium_app USING (atrium.can_access_property(organization_id,property_id,''read''))', table_name);
  END LOOP;
END $$;
CREATE POLICY scoped_insert ON atrium.inbox_events FOR INSERT TO atrium_app WITH CHECK (
  atrium.can_access_property(organization_id,property_id,'operate') AND (
    (atrium.staff_context() AND origin_kind = 'user' AND origin_user_id = atrium.context('actor_user_id')
      AND origin_credential_version::text = atrium.context('credential_version'))
    OR (atrium.channel_context() AND origin_kind = 'channel' AND origin_binding_id = atrium.context('channel_binding_id')
      AND origin_binding_version::text = atrium.context('channel_binding_version')
      AND origin_provider = atrium.context('channel_provider') AND origin_external_id = atrium.context('channel_external_id'))));
CREATE POLICY scoped_insert ON atrium.action_intents FOR INSERT TO atrium_app
  WITH CHECK (atrium.can_access_property(organization_id,property_id,'operate'));
CREATE POLICY scoped_insert ON atrium.outbox_messages FOR INSERT TO atrium_app
  WITH CHECK (atrium.can_access_property(organization_id,property_id,'operate'));
CREATE POLICY scoped_update ON atrium.outbox_messages FOR UPDATE TO atrium_app
  USING (atrium.can_access_property(organization_id,property_id,'operate'))
  WITH CHECK (atrium.can_access_property(organization_id,property_id,'operate'));
CREATE POLICY scoped_append ON atrium.workflow_events FOR INSERT TO atrium_app WITH CHECK (
  atrium.can_access_property(organization_id,property_id,'operate') AND (
    (atrium.staff_context() AND actor_user_id = atrium.context('actor_user_id') AND actor_channel_binding_id IS NULL)
    OR (atrium.channel_context() AND actor_channel_binding_id = atrium.context('channel_binding_id') AND actor_user_id IS NULL)));

REVOKE ALL ON atrium.inbox_events, atrium.action_intents, atrium.outbox_messages, atrium.workflow_events FROM PUBLIC, atrium_authenticator;
REVOKE ALL ON FUNCTION atrium.keep_workflow_evidence(), atrium.keep_outbox_identity() FROM PUBLIC;
GRANT SELECT, INSERT ON atrium.inbox_events, atrium.action_intents, atrium.workflow_events TO atrium_app;
GRANT SELECT, INSERT, UPDATE ON atrium.outbox_messages TO atrium_app;
RESET ROLE;
