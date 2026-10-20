import {createHmac,randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import type {IntegrationSecrets} from './employee-integrations.ts'

/** CloudEvents 是信封；本表租约、固定事件ID和重试负责至少一次投递。接收方仍须去重。 */
export class EmployeeApiWebhooks{
 readonly pool:Pool;readonly secrets:IntegrationSecrets;readonly owner:string;readonly fetcher:typeof fetch;readonly now:()=>Date
 constructor(pool:Pool,secrets:IntegrationSecrets,owner:string,fetcher:typeof fetch=fetch,now:()=>Date=()=>new Date()){this.pool=pool;this.secrets=secrets;this.owner=owner;this.fetcher=fetcher;this.now=now}
 async tick(signal:AbortSignal){
  const db=await this.pool.connect();let item:Record<string,any>|undefined,lease:string|undefined
  try{
   await db.query('begin')
   await db.query("update teloa_employee_api_deliveries d set state='cancelled',lease_until=null,lease_id=null,updated_at=$1 from teloa_employee_integrations i where d.integration_id=i.id and i.owner_id=$2 and d.state='pending' and (i.revoked_at is not null or i.expires_at<=$1)",[this.now(),this.owner])
   item=(await db.query("select d.event_id,d.integration_id,d.attempts,e.body,i.webhook_url from teloa_employee_api_deliveries d join teloa_employee_api_events e on e.id=d.event_id join teloa_employee_integrations i on i.id=d.integration_id where i.owner_id=$2 and d.state='pending' and d.next_at<=$1 and (d.lease_until is null or d.lease_until<$1) and i.revoked_at is null and i.expires_at>$1 order by d.next_at,e.cursor for update of d skip locked limit 1",[this.now(),this.owner])).rows[0]
   if(item){lease=randomUUID();await db.query('update teloa_employee_api_deliveries set attempts=attempts+1,lease_id=$2,lease_until=$3,updated_at=$4 where event_id=$1',[item.event_id,lease,new Date(this.now().getTime()+30_000),this.now()])}
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
  if(!item||!lease)return
  let status:number|null=null,success=false
  try{
   signal.throwIfAborted()
   const secret=await this.secrets.read(item.integration_id)
   if(!secret)throw Error('callback signing key unavailable')
   // 发起前重查撤销；已在途投递可能完成，但不会借重试继续向已撤销集成发送。
   const active=(await this.pool.query('select 1 from teloa_employee_integrations where id=$1 and revoked_at is null and expires_at>$2',[item.integration_id,this.now()])).rowCount
   if(!active){await this.pool.query("update teloa_employee_api_deliveries set state='cancelled',lease_until=null,lease_id=null where event_id=$1 and lease_id=$2",[item.event_id,lease]);return}
   const body=JSON.stringify(item.body),timestamp=String(Math.floor(this.now().getTime()/1000)),signature='v1='+createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex')
   const response=await this.fetcher(item.webhook_url,{method:'POST',redirect:'error',headers:{'content-type':'application/cloudevents+json','teloa-webhook-id':item.event_id,'teloa-webhook-timestamp':timestamp,'teloa-webhook-signature':signature},body,signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)])})
   status=response.status;success=response.ok;await response.body?.cancel()
  }catch{if(signal.aborted){await this.pool.query('update teloa_employee_api_deliveries set lease_until=null,lease_id=null where event_id=$1 and lease_id=$2',[item.event_id,lease]);return}}
  const attempts=Number(item.attempts)+1,state=success?'delivered':attempts>=5?'failed':'pending'
  const delay=[1000,5000,30_000,120_000,600_000][Math.min(attempts-1,4)]!
  await this.pool.query('update teloa_employee_api_deliveries set state=$3,last_status=$4,next_at=$5,lease_until=null,lease_id=null,updated_at=$6 where event_id=$1 and lease_id=$2',[item.event_id,lease,state,status,new Date(this.now().getTime()+delay),this.now()])
 }
 async list(owner:string,integrationId:string){
  return (await this.pool.query('select d.event_id,d.attempts,d.state,d.next_at,d.last_status,d.updated_at from teloa_employee_api_deliveries d join teloa_employee_integrations i on i.id=d.integration_id where i.owner_id=$1 and i.id=$2 order by d.updated_at desc limit 30',[owner,integrationId])).rows.map(row=>({eventId:row.event_id,attempts:row.attempts,state:row.state,nextAt:row.next_at.toISOString(),lastStatus:row.last_status,updatedAt:row.updated_at.toISOString()}))
 }
 async retry(owner:string,eventId:string){
  const result=await this.pool.query("update teloa_employee_api_deliveries d set state='pending',attempts=0,next_at=$3,lease_until=null,lease_id=null,updated_at=$3 from teloa_employee_integrations i where d.event_id=$2 and d.integration_id=i.id and i.owner_id=$1 and i.revoked_at is null and i.expires_at>$3 and d.state='failed' returning d.event_id",[owner,eventId,this.now()])
  return {retried:!!result.rowCount}
 }
}
