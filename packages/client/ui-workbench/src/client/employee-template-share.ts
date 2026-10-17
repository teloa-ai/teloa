import {readTemplateSharePackage,templateShareDigest,type TemplateSharePackage,type TemplateShareIntent,type TemplateShareBridge} from '@teloa/contract'
import {readIndustryDirectory} from './industry-directory.ts'
import {inspectIndustryContent} from './industry-content.ts'
import {isIndustryManifest} from './industry-manifest.ts'
import type {IndustryLoadRecord,IndustryLoadCreateInput} from './industry-load-api.ts'
import type {IndustryKnowledgeRequest} from './industry-knowledge-api.ts'
import type {IndustryRoleRequest} from './industry-role-api.ts'
import type {PreviewRole,RoleFields} from './role-preview.ts'
import type {MarketItem} from './market-preview.ts'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.ts'

type ShareRole=Pick<PreviewRole,'name'|'kind'|'avatarKey'|'duty'|'dataScope'|'executionScope'|'skills'|'knowledge'|'responsibility'>
/** 只重建岗位定义，工作标签不等同于技能正文；源身份和账户完全不读取。 */
export function buildEmployeeTemplate(role:ShareRole):TemplateSharePackage{
 if(role.kind!=='employee')throw Error('Private twin identities cannot be shared as employee templates.')
 const id=crypto.randomUUID(),version='1.0.0',instructions=Object.entries(role.responsibility??{}).map(([key,items])=>items.length?`${key}:\n${items.map(item=>`- ${item}`).join('\n')}`:'').filter(Boolean).join('\n\n')
 const duty=[role.duty,instructions,'Respond in the user’s preferred locale. Ask the new owner which materials, methods and permissions to configure before starting work.'].filter(Boolean).join('\n\n')
 const definition={format:'teloa.role/v1',kind:'employee',name:role.name,...(role.avatarKey===undefined?{}:{avatarKey:role.avatarKey}),duty,dataScope:role.dataScope,executionScope:role.executionScope}
 const manifest={format:'teloa.business-package/v2',id,version,title:role.name,description:role.duty.slice(0,2000),domain:'general',scope:'general',resources:[{id:'employee',kind:'role',title:role.name,version,required:true,source:{kind:'local',path:'role.json'}}],relations:[],entrypoints:[]}
 const extraFiles:{path:string;text:string}[]=[]
 if(duty.length>4000){
  definition.duty=role.duty
  manifest.resources.push({id:'instructions',kind:'knowledge',title:'Working instructions',version,required:true,source:{kind:'local',path:'instructions.md'}})
  ;(manifest.relations as {kind:string;from:string;to:string}[]).push({kind:'role-knowledge',from:'employee',to:'instructions'})
  extraFiles.push({path:'instructions.md',text:duty})
 }
 return readTemplateSharePackage({format:'teloa.template-share/v1',id,version,title:role.name,description:manifest.description,requirements:[...role.skills.map(value=>`Configure a method for: ${value}`),...(role.knowledge.length?[`Connect your own knowledge sources (${role.knowledge.length}).`]:[])],compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:['people']},files:[{path:'teloa.json',text:JSON.stringify(manifest,null,2)},{path:'role.json',text:JSON.stringify(definition,null,2)},{path:'README.md',text:'# Getting started\n\nChoose your own work materials and model account. Review the role instructions and configure any listed methods. A copy does not inherit the author’s accounts, private memory, permissions or running tasks.\n'},...extraFiles]})
}
export function editEmployeeTemplate(pkg:TemplateSharePackage,title:string,description:string):TemplateSharePackage{
 const manifest=JSON.parse(pkg.files.find(f=>f.path==='teloa.json')!.text)
 return readTemplateSharePackage({...pkg,title,description,files:pkg.files.map(f=>f.path==='teloa.json'?{path:f.path,text:JSON.stringify({...manifest,title,description},null,2)}:f)})
}
export async function inspectEmployeeTemplate(value:unknown){
 const pkg=readTemplateSharePackage(value),encoder=new TextEncoder()
 const item=await readIndustryDirectory(pkg.files.map(f=>{const bytes=encoder.encode(f.text);return {path:f.path,size:bytes.length,read:async()=>bytes}}),'teloa.json',pkg.title)
 if(!isIndustryManifest(item.manifest)||!item.packageContent)throw Error('Template manifest could not be read.')
 const inspection=inspectIndustryContent(item.manifest,item.packageContent)
 if(inspection.some(i=>i.state!=='parsed'&&!(i.state==='pending'&&i.definition?.kind==='skill')))throw Error('Template contains invalid or unsupported resource contents.')
 const role=inspection.find(i=>i.definition?.kind==='role')?.definition
 if(role?.kind!=='role'||role.fields.kind!=='employee')throw Error('Template employee is missing.')
 const fields:RoleFields={...role.fields,scopes:['general'],skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
 return {package:pkg,item,manifest:item.manifest,inspection,fields,sha256:await templateShareDigest(pkg)}
}
export type TemplateAcceptanceResult={roleId:string;loadId?:string;pendingKinds:string[]}
type Progress={sha256:string;path?:'industry';roleRequestId:string;contentRequestId:string;loadRequestId:string;acceptanceId?:string;target?:IndustryLoadCreateInput['target'];knowledgeRequests:Record<string,string>;completedKnowledge:string[];content?:{id:string;hash:string};load?:IndustryLoadRecord;result?:TemplateAcceptanceResult}
type AcceptPorts={target:()=>Promise<IndustryLoadCreateInput['target']>;createRole:(fields:RoleFields,requestId:string)=>Promise<string>;importContent:(item:MarketItem,requestId:string)=>Promise<MarketItem>;load:(request:IndustryLoadCreateInput)=>Promise<IndustryLoadRecord>;knowledge:(request:IndustryKnowledgeRequest)=>Promise<{state:string}>;role:(request:IndustryRoleRequest)=>Promise<{state:string;role:{id:string}|null}>;beginAcceptance?:TemplateShareBridge['beginAcceptance'];endAcceptance?:TemplateShareBridge['endAcceptance']}
/** 外层保存稳定阶段身份，底层沿用原 API journal；未知回执再次使用原请求，不重建资源。 */
export function createTemplateAcceptance(storage:WorkbenchNavigationStorage,ports:AcceptPorts){
 let busy=false
 return {async accept(value:TemplateSharePackage,intent?:TemplateShareIntent):Promise<TemplateAcceptanceResult>{
  if(busy)throw Error('Template acceptance is already running.')
  busy=true
  let cleanup:(()=>Promise<void>)|undefined
  try{
   const checked=await inspectEmployeeTemplate(value),key='teloa.template-accept/v1/'+checked.sha256,raw=storage.getItem(key)
   const p:Progress=raw?JSON.parse(raw):{sha256:checked.sha256,path:'industry',roleRequestId:crypto.randomUUID(),contentRequestId:crypto.randomUUID(),loadRequestId:crypto.randomUUID(),knowledgeRequests:{},completedKnowledge:[]}
   if(p.sha256!==checked.sha256||p.path!==undefined&&p.path!=='industry'||!p.roleRequestId||!p.loadRequestId||!p.contentRequestId||!p.knowledgeRequests||!Array.isArray(p.completedKnowledge))throw Error('Template recovery record is invalid.')
   // 旧单岗位申请可能已直建成功而回执丢失；不换路径、不清租约、不改原记录，等待核对原申请。
   if(!p.result&&p.path===undefined&&checked.manifest.resources.length===1)throw Object.assign(Error('The original employee request is unconfirmed. Check the original request before continuing.'),{code:'acceptance-recovery-required'})
   const save=()=>storage.setItem(key,JSON.stringify(p))
   cleanup=async()=>{if(!p.acceptanceId)return;if(!ports.endAcceptance)throw Error('Template acceptance context cannot be closed.');await ports.endAcceptance({acceptanceId:p.acceptanceId});delete p.acceptanceId;save()}
   if(p.result)return p.result
   save()
   if(p.acceptanceId)await cleanup()
   if(ports.beginAcceptance){
    if(!ports.endAcceptance)throw Error('Template acceptance context cannot be closed.')
    const lease=await ports.beginAcceptance({requestId:p.roleRequestId,...(intent?{shareId:intent.shareId}:{})})
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lease.acceptanceId))throw Error('Template acceptance context is invalid.')
    p.acceptanceId=lease.acceptanceId;save()
   }
   if(!p.target){p.target=await ports.target();save()}
   if(!p.content){const item=await ports.importContent(checked.item,p.contentRequestId);if(!item.contentStorage?.contentId||!item.packageContent?.hash)throw Error('Template content has not been saved.');p.content={id:item.contentStorage.contentId,hash:item.packageContent.hash};save()}
   if(!p.content)throw Error('Template content has not been saved.')
   if(!p.load){p.load=await ports.load({requestId:p.loadRequestId,contentId:p.content.id,contentHash:p.content.hash,target:p.target});save()}
   for(const item of p.load.items.filter(i=>i.kind==='knowledge'&&i.status!=='skipped')){
    if(p.completedKnowledge.includes(item.instanceId))continue
    p.knowledgeRequests[item.instanceId]??=crypto.randomUUID();save()
    const result=await ports.knowledge({requestId:p.knowledgeRequests[item.instanceId]!,loadId:p.load.id,itemInstanceId:item.instanceId})
    if(result.state!=='active')throw Error('Template knowledge requires recovery before adding the employee.')
    p.completedKnowledge.push(item.instanceId);save()
   }
   const employee=p.load.items.find(i=>i.kind==='role');if(!employee)throw Error('Template load did not return an employee.')
   const result=await ports.role({requestId:p.roleRequestId,loadId:p.load.id,itemInstanceId:employee.instanceId})
   if(!result.role||!['paused','active'].includes(result.state))throw Error('Template employee requires recovery.')
   p.result={roleId:result.role.id,loadId:p.load.id,pendingKinds:[...new Set(p.load.items.filter(i=>['skill','plan','work-template'].includes(i.kind)&&i.status!=='skipped').map(i=>i.kind))]};save();return p.result
  }finally{try{await cleanup?.()}finally{busy=false}}
 }}
}
