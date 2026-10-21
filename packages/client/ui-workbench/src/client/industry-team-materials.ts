import {WorkError,isGroupAgentGrant,type GroupAgentGrant,type MessageReference} from '@teloa/contract'
import {industryTeamSeed,industryTeamRole,matchingIndustryTeam,type IndustryTeamSeed} from './industry-team.ts'
import type {GroupApi,GroupSnapshot} from './group-api.ts'
import type {IndustryLoadApi} from './industry-load-api.ts'
import type {IndustryKnowledgeApi} from './industry-knowledge-api.ts'
import type {IndustryRoleApi} from './industry-role-api.ts'
import type {MarketContentApi} from './market-content-api.ts'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.ts'
import {isIndustryManifest} from './industry-manifest.ts'

export type TeamMaterialDocument={id:string;title:string;path:string;text:string;hash:string;roleIds:string[];itemInstanceId:string;sourceId:string;sourceVersion:string;resourceId:string;resourceVersion:number}
export type TeamMaterialRole={id:string;name:string;version:number;state:string;grant:GroupAgentGrant|null}
export type IndustryTeamMaterialsPreview={group:GroupSnapshot;seed:IndustryTeamSeed;roles:TeamMaterialRole[];documents:TeamMaterialDocument[]}
export type IndustryTeamMaterialsPort={canReview?:((groupId:string)=>boolean)|undefined;review?:((groupId:string)=>void)|undefined;complete?:((groupId:string)=>void)|undefined;load:(group:GroupSnapshot)=>Promise<IndustryTeamMaterialsPreview>;pending:(groupId:string)=>string[]|undefined;prepare:(preview:IndustryTeamMaterialsPreview,selected:string[],isCurrent:()=>boolean,references?:readonly MessageReference[])=>Promise<MessageReference[]>}
export type TeamMaterialPack={id:string;title:string;markdown:string;hash:string;documentIds:string[]}
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const same=(a:unknown,b:unknown)=>stable(a)===stable(b)
const fail=()=>new WorkError('teloa/source-unavailable','模板资料或原群状态已改变，请重新核对。')
const conflict=()=>new WorkError('teloa/version-conflict','群资料或员工授权已改变，请先核对原请求。')
const sha=async(value:Uint8Array|string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):Uint8Array.from(value))),byte=>byte.toString(16).padStart(2,'0')).join('')
const sourceKey=(id:string)=>'teloa.industry-team-materials/v1/'+id
const referenceKey=(r:MessageReference)=>r.kind+':'+r.id
/** 保留原草稿/授权引用；同一对象不同版本不能被静默替换。 */
export function mergeTeamMaterialReferences(before:readonly MessageReference[],added:readonly MessageReference[],max=8):MessageReference[]{
 const result=before.map(item=>({...item}))
 for(const item of added){const old=result.find(row=>referenceKey(row)===referenceKey(item));if(old&&old.version!==item.version)throw conflict();if(!old)result.push({...item})}
 if(result.length>max)throw new WorkError('teloa/invalid-input','请先减少输入框中的资料引用。')
 return result
}

/** 只从精确固定包读取静态原文；不读个人知识正文、记忆或被本地编辑的岗位资料。 */
export async function readIndustryTeamMaterials(snapshot:GroupSnapshot,ports:{groups:GroupApi;loads:IndustryLoadApi;roles:IndustryRoleApi;knowledge:IndustryKnowledgeApi;contents:MarketContentApi}):Promise<IndustryTeamMaterialsPreview>{
 const source=snapshot.group.source;if(!source)throw fail()
 const [group,load,instances,knowledge,items]=await Promise.all([ports.groups.get(snapshot.group.id),ports.loads.get(source.loadId),ports.roles.list(),ports.knowledge.list(),ports.contents.list()])
 const rows=instances.map(row=>({loadId:row.loadId,itemInstanceId:row.itemInstanceId,state:row.state,...(row.role?{roleId:row.role.id}:{})})),seed=industryTeamSeed(load,rows)
 if(!seed||!same(seed.source,source)||!matchingIndustryTeam(group,seed))throw fail()
 const summaries=items.filter(item=>item.contentStorage?.contentId===source.contentId);if(summaries.length!==1)throw fail()
 const item=await ports.contents.hydrate(summaries[0]!),manifest=item.manifest,content=item.packageContent
 if(!content||item.contentStorage?.loaded!==true||item.contentStorage?.contentId!==source.contentId||content.hash!==source.contentHash||!isIndustryManifest(manifest))throw fail()
 const roles:TeamMaterialRole[]=[]
 for(const id of seed.memberRoleIds){const mapped=load.items.filter(item=>item.kind==='role').flatMap(item=>{const row=industryTeamRole(load,item.instanceId,rows);return row?.roleId===id?[row]:[]});if(mapped.length!==1)throw fail();const original=instances.find(instance=>instance.itemInstanceId===mapped[0]!.itemInstanceId)?.role;if(!original||!['active','paused'].includes(original.state))throw fail();const read=await ports.groups.agentGrant(group.group.id,id);if(read.groupVersion!==group.group.version||read.roleVersion!==original.version)throw conflict();roles.push({id,name:original.name,version:original.version,state:original.state,grant:read.grant})}
 const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',documents:TeamMaterialDocument[]=[]
 for(const definition of manifest.resources.filter(row=>row.kind==='knowledge')){
  const mapped=load.items.find(row=>row.localId===definition.id&&row.kind==='knowledge');if(!mapped||mapped.status==='skipped')continue
  if(definition.source.kind!=='local'||definition.version!==mapped.version)throw fail()
  const path=root+definition.source.path,file=content.files.find(file=>file.path===path);if(!file||file.bytes.length>128*1024||await sha(file.bytes)!==file.hash)throw fail()
  const current=knowledge.filter(row=>row.itemInstanceId===mapped.instanceId),candidates=current.length?current:mapped.carriedFrom?knowledge.filter(row=>row.itemInstanceId===mapped.carriedFrom):[]
  const known=candidates[0];if(candidates.length!==1||!known||known.state!=='active'||!known.resource||known.resource.status!=='active'||known.scope!==load.space.scope||known.itemLocalId!==definition.id||known.sourceVersion!==file.hash||known.resource.sourceVersion!==file.hash||known.resource.sourceId!==known.sourceId||current.length&&known.loadId!==load.id)throw fail()
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes)}catch{throw fail()}if(!text.trim())throw fail()
  const roleIds=load.relations.filter(link=>link.kind==='role-knowledge'&&link.to===mapped.instanceId).map(link=>industryTeamRole(load,link.from,rows)?.roleId);if(roleIds.some(id=>!id||!seed.memberRoleIds.includes(id)))throw fail()
  documents.push({id:definition.id,title:mapped.title,path,text,hash:file.hash,roleIds:[...new Set(roleIds)] as string[],itemInstanceId:mapped.instanceId,sourceId:known.sourceId,sourceVersion:known.sourceVersion,resourceId:known.resource.id,resourceVersion:known.resource.version})
 }
 return {group,seed,roles,documents}
}

/** 包装只加独立来源段和样例提示，每份原文逐字保留。固定四包受既有 16k/8 引用边界约束。 */
export async function industryTeamMaterialPacks(preview:IndustryTeamMaterialsPreview,selected:readonly string[]):Promise<TeamMaterialPack[]>{
 if(!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!preview.documents.some(row=>row.id===id)))throw fail()
 const chosen=preview.documents.filter(row=>selected.includes(row.id)),buckets=[...preview.roles.map(role=>({key:role.id,title:role.name,documents:chosen.filter(doc=>doc.roleIds.length===1&&doc.roleIds[0]===role.id)})),{key:'shared',title:preview.group.group.name,documents:chosen.filter(doc=>doc.roleIds.length!==1)}].filter(row=>row.documents.length)
 if(buckets.length>8)throw fail()
 return Promise.all(buckets.map(async bucket=>{
  const sources=bucket.documents.map(({text,...doc})=>doc),title=bucket.title.slice(0,104)+' · 模板参考',markdown='# '+title+'\n\n> Template reference. Examples are format samples, not verified business facts.\n\n```json\n'+stable({format:'teloa.template-group-material/v1',source:preview.seed.source,documents:sources})+'\n```\n\n'+bucket.documents.map(doc=>'## '+doc.title+'\n<!-- source '+doc.hash+' -->\n'+doc.text+'\n<!-- end source '+doc.hash+' -->').join('\n\n')
  if(markdown.length>16000)throw new WorkError('teloa/invalid-input','所选模板资料超过单份群资料长度，请减少选择。')
  const hash=await sha(markdown),identity=await sha(stable([preview.group.group.id,preview.seed.source,bucket.key,hash])),raw=identity.slice(0,32).split('');raw[12]='5';raw[16]=((parseInt(raw[16]!,16)&3)|8).toString(16);const hex=raw.join(''),id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20)
  return {id,title,markdown,hash,documentIds:bucket.documents.map(doc=>doc.id)}
 }))
}

type MaterialOperation={schema:'teloa.industry-team-materials/v1';groupId:string;groupVersion:number;source:IndustryTeamSeed['source'];selected:string[];packs:TeamMaterialPack[];roles:TeamMaterialRole[]}
/** 组合不另发请求：原 GroupApi journal 是唯一未决子请求，关闭/刷新后只恢复它。 */
export function createIndustryTeamMaterials(ports:{groups:GroupApi;loads:IndustryLoadApi;roles:IndustryRoleApi;knowledge:IndustryKnowledgeApi;contents:MarketContentApi;storage:WorkbenchNavigationStorage}):IndustryTeamMaterialsPort{
 const read=(id:string):MaterialOperation|undefined=>{const raw=ports.storage.getItem(sourceKey(id));if(raw===null)return undefined;try{if(raw.length>512*1024)throw fail();const value=JSON.parse(raw) as MaterialOperation;if(value.schema!=='teloa.industry-team-materials/v1'||value.groupId!==id||!Array.isArray(value.selected)||!Array.isArray(value.packs)||!Array.isArray(value.roles)||value.roles.some(role=>role.grant!==null&&!isGroupAgentGrant(role.grant)))throw fail();return value}catch{throw fail()}}
 const persist=(op:MaterialOperation)=>ports.storage.setItem(sourceKey(op.groupId),JSON.stringify(op))
 let running=false
 return {
  canReview:()=>!running&&!ports.groups.pending(),review:id=>{if(running||ports.groups.pending())throw conflict();ports.storage.removeItem(sourceKey(id))},
  load:snapshot=>readIndustryTeamMaterials(snapshot,ports),pending:id=>read(id)?.selected,complete:id=>{if(ports.groups.pending())throw conflict();if(read(id))ports.storage.removeItem(sourceKey(id))},
  async prepare(preview,selected,isCurrent,references=[]){
   if(running)throw conflict();running=true
   try{
    const current=()=>{if(!isCurrent())throw new WorkError('teloa/cancelled','已离开原群。')};current()
    const fresh=await readIndustryTeamMaterials(preview.group,ports);current()
    if(!same(fresh.seed,preview.seed)||fresh.group.group.version!==preview.group.group.version||!same(fresh.documents,preview.documents)||!same(fresh.roles.map(({grant,...role})=>role),preview.roles.map(({grant,...role})=>role)))throw conflict()
    const packs=await industryTeamMaterialPacks(fresh,selected),refs=packs.map(pack=>({kind:'group-resource' as const,id:pack.id,version:1}));mergeTeamMaterialReferences(references,refs)
    let op=read(fresh.group.group.id)
    if(op){if(op.groupVersion!==fresh.group.group.version||!same(op.source,fresh.seed.source)||!same(op.selected,selected)||!same(op.packs,packs)||!same(op.roles.map(({grant,...role})=>role),fresh.roles.map(({grant,...role})=>role)))throw conflict()}
    else{if(ports.groups.pending())throw conflict();if(fresh.roles.some(role=>role.grant?.state==='revoked'))throw conflict();if(!same(fresh.roles,preview.roles))throw conflict();op={schema:'teloa.industry-team-materials/v1',groupId:fresh.group.group.id,groupVersion:fresh.group.group.version,source:fresh.seed.source,selected:[...selected],packs,roles:fresh.roles};persist(op)}
    const union=(role:TeamMaterialRole)=>mergeTeamMaterialReferences(role.grant?.resources??[],refs,32)
    // 未知子请求不能凭“目标已经存在”跳过，必须核对原 UUID；不消费其它群的 journal。
    const pending=ports.groups.pending()
    if(pending){
     if(pending.kind==='save-resource'){const pack=packs.find(pack=>pack.id===pending.request.resourceId);if(!pack||pending.request.groupId!==op.groupId||pending.request.expectedVersion!==0||pending.request.title!==pack.title||pending.request.markdown!==pack.markdown)throw conflict()}
     else if(pending.kind==='agent-grant'){const role=op.roles.find(role=>role.id===pending.request.roleId);if(!role||pending.request.groupId!==op.groupId||pending.request.expectedGroupVersion!==op.groupVersion||pending.request.expectedRoleVersion!==role.version||pending.request.expectedGrantVersion!==(role.grant?.grantVersion??0)||pending.request.action!=='save'||!same(pending.request.resources,union(role))||pending.request.canPost!==(role.grant?.canPost??false)||pending.request.canAutoRun!==(role.grant?.canAutoRun??false))throw conflict()}
     else throw conflict()
     current();await ports.groups.recover();current()
    }
    let resources=(await ports.groups.resources(op.groupId)).items;current()
    for(const pack of packs){
     let resource=resources.find(resource=>resource.id===pack.id)
     if(!resource){current();resource=await ports.groups.saveResource(op.groupId,pack.id,0,pack.title,pack.markdown);current();resources=[...resources,resource]}
     if(resource.withdrawnAt!==null||resource.version!==1||resource.title!==pack.title)throw conflict()
     const original=await ports.groups.resource(op.groupId,resource.id,1);current();if(original.title!==pack.title||original.markdown!==pack.markdown)throw conflict()
    }
    for(const role of op.roles){
     const latest=await ports.groups.agentGrant(op.groupId,role.id);current();const expected=union(role),grant=latest.grant,canPost=role.grant?.canPost??false,canAutoRun=role.grant?.canAutoRun??false
     if(grant?.state==='revoked')throw conflict()
     if(grant&&grant.groupVersion===op.groupVersion&&grant.roleVersion===role.version&&same(grant.resources,expected)&&grant.canPost===canPost&&grant.canAutoRun===canAutoRun)continue
     if(!same(grant,role.grant))throw conflict()
     await ports.groups.changeAgentGrant(op.groupId,role.id,op.groupVersion,role.version,'save',expected,canPost,canAutoRun,grant?.grantVersion??0);current()
    }
    // 所有真实资源与授权回执齐备后才交给原输入框，不发送、不恢复员工。
    current();return refs
   }finally{running=false}
  },
 }
}
