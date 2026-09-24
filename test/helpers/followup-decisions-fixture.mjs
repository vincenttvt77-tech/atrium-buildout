import { randomUUID } from 'node:crypto'
import { createCancellationEmailFixture } from './cancellation-email-fixture.mjs'
export async function createFollowUpDecisionsFixture() {
  const f=await createCancellationEmailFixture()
  const row={id:'fu-synthetic-staff-callback',phone:'+12025550101',kind:'callback',channel:'call',
    dueAt:new Date(Date.now()-60000).toISOString(),reason:'Synthetic visitor requested a leasing callback',status:'scheduled',
    createdAt:new Date(Date.now()-120000).toISOString(),createdFromCall:'synthetic-call',executable:false}
  async function save(value,property='property-a1',org='organization-a') {
    await f.db.admin.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES($1,$2,$3,$4)
      ON CONFLICT(organization_id,property_id,key) DO UPDATE SET value=EXCLUDED.value`,[org,property,'followup:'+row.id,JSON.stringify(value)])
  }
  const raw=async(property='property-a1')=>(await f.db.admin.query('SELECT value FROM atrium.operational_documents WHERE property_id=$1 AND key=$2',[property,'followup:'+row.id])).rows[0]?.value
  const request=options=>f.request({path:'/api/leads',...options})
  const current=async options=>{const result=await request(options);if(result.status!==200)throw new Error(JSON.stringify(result));return result.body.followUps.find(r=>r.id===row.id)}
  const command=(current,status='done')=>({action:'followup_status',id:row.id,status,expectedSha256:current.expectedSha256,requestId:randomUUID()})
  async function reset(){await f.reset({cancelled:false});await save(row);await save(row,'property-b1','organization-b')}
  await reset()
  return {...f,row,save,raw,request,current,command,reset}
}
