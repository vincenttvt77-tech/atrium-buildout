-- Storage for the mock property-management system used in demonstrations.
--
-- This is the fake system's own filing cabinet, not Atrium's. Atrium already records what
-- it intends to do, what it attempted and what came back, in atrium.workflow_* through the
-- durable workflow engine. Duplicating any of that here would create a second account of
-- the same events. What is missing is somewhere for the stand-in target to keep the records
-- it claims to hold, so that a read-back has something to read.
--
-- Additive by construction: a later timestamp than every applied migration, its own schema,
-- and no change to any existing object. Deviation noted in docs/demo-buildout/plan.md.
--
-- Every migration shares one transaction, and the one before this leaves atrium_admin as
-- the current role. Creating a schema needs CREATE on the database, which that role does
-- not hold, so this starts from the session role the first migration also used.
RESET ROLE;
CREATE SCHEMA atrium_demo AUTHORIZATION atrium_admin;
REVOKE ALL ON SCHEMA atrium_demo FROM PUBLIC;
SET LOCAL ROLE atrium_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA atrium_demo REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA atrium_demo REVOKE ALL ON TABLES FROM PUBLIC;

-- What the stand-in system believes it holds. Keyed by the workflow operation key, which
-- is what makes the fake target deduplicate the way a well-behaved provider does, and what
-- a read-back searches on after a result nobody saw.
--
-- `hidden` models a target that has accepted a write but not yet made it visible to reads.
-- Without it a demonstration cannot show the difference between a record that is missing
-- and a record that is merely late, and those two need opposite responses.
CREATE TABLE atrium_demo.mock_property_records (
  operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 256),
  organization_id atrium.record_id NOT NULL,
  property_id atrium.record_id NOT NULL,
  provider_reference text NOT NULL
    CHECK (length(provider_reference) BETWEEN 1 AND 256 AND provider_reference !~ '[[:cntrl:]]'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, property_id) REFERENCES atrium.properties(organization_id, id)
);
CREATE INDEX mock_property_records_property_idx
  ON atrium_demo.mock_property_records (organization_id, property_id, created_at DESC);

-- How the stand-in system behaves on the next write, so a presenter can arm a failure in
-- front of an audience instead of hoping one occurs. It applies once and returns to
-- 'accept', because a demonstration that stays broken is not a demonstration of recovery.
CREATE TABLE atrium_demo.mock_property_behavior (
  organization_id atrium.record_id NOT NULL,
  property_id atrium.record_id NOT NULL,
  behavior text NOT NULL DEFAULT 'accept' CHECK (behavior IN
    ('accept', 'reject', 'timeout', 'timeout_after_write', 'drift', 'invisible_once')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, property_id),
  FOREIGN KEY (organization_id, property_id) REFERENCES atrium.properties(organization_id, id)
);

GRANT USAGE ON SCHEMA atrium_demo TO atrium_app;
GRANT SELECT, INSERT, UPDATE ON atrium_demo.mock_property_records TO atrium_app;
GRANT SELECT, INSERT, UPDATE ON atrium_demo.mock_property_behavior TO atrium_app;
REVOKE CREATE ON SCHEMA atrium_demo FROM atrium_app;
RESET ROLE;
