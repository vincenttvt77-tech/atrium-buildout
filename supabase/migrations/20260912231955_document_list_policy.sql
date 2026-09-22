-- Check live read authority once per statement, rather than once per document.
-- Row ownership remains explicit; the InitPlan is not a transaction/session cache.
-- Existing write policies, FORCE RLS, privileges and authorization helpers remain.
SET LOCAL ROLE atrium_admin;

ALTER POLICY scoped_read ON atrium.operational_documents
  USING (
    organization_id = (SELECT atrium.context('organization_id'))
    AND property_id = (SELECT atrium.context('property_id'))
    AND (SELECT atrium.can_access_property(
      atrium.context('organization_id'),
      atrium.context('property_id'),
      'read'))
  );

RESET ROLE;
