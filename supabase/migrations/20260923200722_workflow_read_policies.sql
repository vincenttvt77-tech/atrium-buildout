-- Evaluate current property authority once per statement, never once per session.
-- Row equality is still mandatory: permission for the selected property cannot
-- expose another property's rows, even to an organization-wide owner.
-- can_access_property is STABLE and remains SECURITY INVOKER with existing RLS.
-- This changes no write policies, roles, grants, functions, data or timeouts.
SET LOCAL ROLE atrium_admin;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['inbox_events','action_intents','outbox_messages','workflow_events']
  LOOP
    EXECUTE format('ALTER POLICY scoped_read ON atrium.%I USING (
      organization_id = (SELECT atrium.context(''organization_id''))
      AND property_id = (SELECT atrium.context(''property_id''))
      AND (SELECT atrium.can_access_property(
        atrium.context(''organization_id''), atrium.context(''property_id''), ''read''))
    )', table_name);
  END LOOP;
END $$;
