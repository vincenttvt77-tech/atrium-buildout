import { hashJson } from '../../src/workflows/validation.ts'

/** Synthetic history only, in a disposable database. No provider or runtime write bypass. */
export async function seedWorkflowHistory(admin, { organizationId, propertyId, userId, count = 300 }) {
  const rows = Array.from({ length: count }, (_, index) => {
    const id = `history-${propertyId}-${String(index).padStart(6, '0')}`
    const operationKey = `history-operation-${index}`
    return { id, operationKey, hash: hashJson([organizationId, propertyId, 'synthetic', 'test.create', operationKey]),
      manifest: [{ kind: 'test.create', connector: 'synthetic', operationKey, input: {}, maxAttempts: 2 }] }
  })
  const args = [organizationId, propertyId, userId, JSON.stringify(rows), hashJson({})]
  await admin.query(`INSERT INTO atrium.inbox_events(organization_id,property_id,id,source,event_id,
    origin_kind,origin_user_id,origin_credential_version,configuration_version,request_id,payload,payload_sha256,action_manifest)
    SELECT $1,$2,item->>'id','synthetic-history',item->>'id','user',$3,1,1,item->>'id','{}',$5,item->'manifest'
    FROM jsonb_array_elements($4::jsonb) item`, args)
  await admin.query(`INSERT INTO atrium.action_intents(organization_id,property_id,id,receipt_id,kind,connector,
    source_operation_key,operation_key,input,input_sha256,max_attempts,created_at)
    SELECT $1,$2,item->>'id',item->>'id','test.create','synthetic',item->>'operationKey',item->>'hash','{}',$4,2,
      '2026-09-01T12:00:00Z'::timestamptz + ((ordinality / 3)::integer * interval '1 millisecond')
    FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS items(item,ordinality)`,
  [organizationId, propertyId, JSON.stringify(rows), hashJson({})])
  await admin.query(`INSERT INTO atrium.outbox_messages(organization_id,property_id,action_id)
    SELECT $1,$2,item->>'id' FROM jsonb_array_elements($3::jsonb) item`, [organizationId, propertyId, JSON.stringify(rows)])
  return rows.map(row => row.id)
}
