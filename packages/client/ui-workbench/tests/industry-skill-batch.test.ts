import test from 'node:test'
import assert from 'node:assert/strict'
import {createSkillInstallApi} from '../lib/types/client/skill-install-api.js'
import {previewIndustrySkills,prepareIndustrySkills} from '../lib/types/client/industry-skill-batch.js'

const loadId='77777777-7777-4777-8777-777777777777',roleId='88888888-8888-4888-8888-888888888888'
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']
function fixture(){
 const installed=new Map<string,any>(),calls:Array<{method:string;input:any}>=[]
 let journal:string|null=null,enabled=false,drift=false,lost=false,unavailable=false,installs=0
 const preview=(itemInstanceId:string)=>{const index=ids.indexOf(itemInstanceId);return {
  source:{kind:'industry-local',loadId,itemInstanceId,contentId:loadId,contentHash:'c'.repeat(64),resourceId:'method-'+index,resourceVersion:'1.0.0'},bundleHash:String(index+1).repeat(64),
  native:{name:'method-'+index,description:'Method '+index,modelInvocable:true,userInvocable:true,bodyHash:'b'.repeat(64)},files:[{path:'SKILL.md',hash:'f'.repeat(64),size:100},...(index?[{path:'scripts/check.py',hash:'e'.repeat(64),size:40}]:[])],
 }}
 const api=createSkillInstallApi(async(method,input:any)=>{
  calls.push({method,input})
  if(method==='skill-installations/preview')return preview(input.source.itemInstanceId)
  if(method==='skill-installations/install'){
   const item=preview(input.source.itemInstanceId)
   assert.equal(input.expectedBundleHash,item.bundleHash)
   const record=installed.get(input.source.itemInstanceId)??{id:input.source.itemInstanceId,ownerId:'fixture-owner',source:item.source,bundleHash:item.bundleHash,native:item.native,state:'installed',version:1,createdAt:'2026-10-30T00:00:00.000Z',updatedAt:'2026-10-30T00:00:00.000Z'}
   if(!installed.has(input.source.itemInstanceId)){installed.set(input.source.itemInstanceId,record);installs++}
   if(lost){lost=false;throw Error('安装完成后回包丢失')}
   return {installation:record,source:item.source}
  }
  if(method==='skill-installations/observe'){
   const record=installed.get(input.installationId)
   return {installationId:input.installationId,scope:'default-workspace',state:unavailable?'missing':'available',current:unavailable?null:{...record.native,provider:'teloa-market',source:'managed'}}
  }
  throw Error('Unexpected call: '+method)
 },{read:()=>journal,write:value=>{journal=value},clear:()=>{journal=null}})
 const read=async()=>({loadId,status:'active',title:'New package',version:'1.0.0',digest:(drift?'f':String(installed.size)).repeat(64),counts:{ready:installed.size+Number(enabled),auto:Number(!enabled),needsUser:ids.length-installed.size,optional:0,pending:0},rows:[
  {itemInstanceId:roleId,kind:'role',title:'New employee',state:enabled?'ready':'auto',step:enabled?null:'role',entry:null},
  ...ids.map((id,index)=>({itemInstanceId:id,kind:'skill',title:'Method '+index,state:installed.has(id)?'ready':'needs-user',step:null,entry:installed.has(id)?null:'skill-confirm'})),
 ]})
 const port={read,prepare:async(id:string,digest:string)=>{
  assert.equal(id,loadId);assert.equal(digest,(await read()).digest);assert.equal(installed.size,2)
  calls.push({method:'industry-loads/prepare',input:{id,digest}});enabled=true
  return {loadId,digest,results:[{itemInstanceId:roleId,title:'New employee',step:'role-resume',outcome:'done',code:null,message:null}],readiness:await read()}
 }}
 return {api,port,calls,preview,read:read as any,enabled:()=>enabled,installs:()=>installs,loseResponse:()=>{lost=true},drift:()=>{drift=true},unavailable:()=>{unavailable=true}}
}

test('新包：只读批量预览本地和带脚本的 SKILL，一次确认后逐个安装、核验再准备员工',async()=>{
 const f=fixture(),initial=await f.read(),batch=await previewIndustrySkills(f.api,initial)
 assert.equal(batch.items.length,2)
 assert.ok(batch.items[1]!.preview.files.some(file=>file.path==='scripts/check.py'))
 assert.ok(f.calls.every(call=>call.method==='skill-installations/preview'),'确认前不安装')
 const receipt=await prepareIndustrySkills(f.api,batch,initial,f.port as any)
 assert.equal(f.enabled(),true);assert.equal(f.installs(),2)
 assert.deepEqual(f.calls.filter(call=>call.method!=='skill-installations/preview').map(call=>call.method),['skill-installations/install','skill-installations/observe','skill-installations/install','skill-installations/observe','industry-loads/prepare'])
 assert.equal(receipt.results.filter(row=>row.step==='skill'&&row.outcome==='done').length,2)
 assert.equal(receipt.readiness!.counts.needsUser,0)
})

test('新包：安装已落地但回包丢失，重新确认会沿原请求恢复，不重复安装且继续准备剩余技能',async()=>{
 const f=fixture(),initial=await f.read(),batch=await previewIndustrySkills(f.api,initial)
 f.loseResponse()
 await assert.rejects(prepareIndustrySkills(f.api,batch,initial,f.port as any),/回包丢失/)
 assert.equal(f.enabled(),false)
 const pending=f.api.pending()!;assert.equal(pending.requestId,batch.items[0]!.request.requestId)
 const current=await f.read(),again=await previewIndustrySkills(f.api,current)
 assert.equal(again.items.length,2,'已安装但待核对的原请求仍在确认清单')
 await prepareIndustrySkills(f.api,again,current,f.port as any)
 assert.equal(f.installs(),2);assert.equal(f.enabled(),true);assert.equal(f.api.pending(),undefined)
 const retries=f.calls.filter(call=>call.method==='skill-installations/install'&&call.input.source.itemInstanceId===ids[0])
 assert.equal(retries.length,2);assert.equal(retries[0]!.input.requestId,retries[1]!.input.requestId)
})

test('新包：预览后加载状态改变，在首次安装前拒绝执行；技能未真正生效时不启用员工',async()=>{
 const stale=fixture(),initial=await stale.read(),batch=await previewIndustrySkills(stale.api,initial)
 stale.drift()
 await assert.rejects(prepareIndustrySkills(stale.api,batch,initial,stale.port as any),/已变化/)
 assert.equal(stale.installs(),0)
 const unavailable=fixture(),fresh=await unavailable.read(),items=await previewIndustrySkills(unavailable.api,fresh)
 unavailable.unavailable()
 await assert.rejects(prepareIndustrySkills(unavailable.api,items,fresh,unavailable.port as any),/尚未.*生效/)
 assert.equal(unavailable.installs(),1);assert.equal(unavailable.enabled(),false)
})

test('新包：不吞掉其他加载的待核对安装，保持原恢复记录',async()=>{
 const f=fixture(),initial=await f.read(),batch=await previewIndustrySkills(f.api,initial)
 f.loseResponse()
 await assert.rejects(f.api.install({...batch.items[0]!.request,source:{kind:'industry',loadId:roleId,itemInstanceId:ids[0]!}}))
 const pending=f.api.pending()!
 const current=await f.read(),again=await previewIndustrySkills(f.api,current)
 await assert.rejects(prepareIndustrySkills(f.api,again,current,f.port as any),/另一项/)
 assert.deepEqual(f.api.pending(),pending);assert.equal(f.enabled(),false)
})
