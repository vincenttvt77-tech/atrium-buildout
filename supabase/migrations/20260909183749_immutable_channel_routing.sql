-- A saved provider identity must never redirect historical callbacks or calls
-- into another property. Retire it and provision a distinct provider identity.
SET LOCAL ROLE atrium_admin;

CREATE FUNCTION atrium.preserve_channel_routing() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Channel routing identities must be retired, not deleted' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.id,NEW.provider,NEW.external_id,NEW.organization_id,NEW.property_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.provider,OLD.external_id,OLD.organization_id,OLD.property_id) THEN
      RAISE EXCEPTION 'Channel routing identity and property ownership are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $$;

REVOKE ALL ON FUNCTION atrium.preserve_channel_routing() FROM PUBLIC;
CREATE TRIGGER preserve_channel_routing BEFORE UPDATE OR DELETE ON atrium.channel_bindings
  FOR EACH ROW EXECUTE FUNCTION atrium.preserve_channel_routing();

-- Staff may enumerate only the selected property's active provider bindings.
-- This policy deliberately does not call can_access_property (which references
-- properties and bindings) and therefore keeps the RLS dependency graph acyclic.
DROP POLICY app_binding ON atrium.channel_bindings;
CREATE POLICY app_binding ON atrium.channel_bindings FOR SELECT TO atrium_app USING (
  status = 'active' AND (
    (atrium.channel_context() AND id = atrium.context('channel_binding_id')
      AND permission_version::text = atrium.context('channel_binding_version'))
    OR (organization_id = atrium.context('organization_id') AND property_id = atrium.context('property_id')
      AND atrium.staff_property_permission(organization_id,property_id,'read'))
  )
);

RESET ROLE;
