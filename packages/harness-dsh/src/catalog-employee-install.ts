import {createHash} from 'node:crypto'
import {WorkError,isRecord,type MarketCatalogRoleEntry} from '@teloa/contract'

/**
 * 单个目录 AI 员工的完整资源安装（不另建运行引擎）：复用固定内容 → 行业加载 → 方法安装 → 原一键准备这条既有链路。
 * 1. 按条目 `fromSolution` 唯一解析父包，导入只含该员工与其直接关联资源的固定派生包（不连带同团队其他员工）；
 * 2. 加载到本人当前空间（不新建业务空间）；
 * 3. 员工的方法按本加载条目逐个安装（本人在组成预览确认即授权安装），回执给出实际原生名；
 * 4. 方法全部装好才调用原 `industry-loads/prepare`（`activate:false`）：实例化资料、按 role.json 建员工、经原 `roles/edit`
 *    绑定实际原生名，员工保持暂停；应用连接与上岗仍由本人各自授权。
 * 所有子请求 id 由（本人, 条目, 版本, 代次, 步骤）派生：回执丢失、重启或换新服务后再点一次落到同一内容、加载、安装与员工。
 * 旧 v1 直接建岗的员工原样返回旧回执形状，不被替换。
 */
type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type CatalogEmployeeLocation={legacyRoleId:string|null;generation:number;loadId:string|null;roleId:string|null;roleState:string|null}
export type CatalogEmployeePorts={
 entry:(entryId:string)=>MarketCatalogRoleEntry
 locate:(entry:MarketCatalogRoleEntry)=>Promise<CatalogEmployeeLocation>
 importContent:(input:{requestId:string;entryId:string;generation:number})=>Promise<{id:string;hash:string}>
 currentSpace:()=>Promise<{id:string;version:number}>
 loads:Call
 skills:Call
 /** 原行业员工 handler 的 industry-roles/list。 */
 roles:Call
 /** 原一键准备 handler；`activate:false` 建员工并绑定方法后保持暂停。 */
 prepare:(endpoint:'industry-loads/readiness'|'industry-loads/prepare',payload:unknown,options:{activate:false})=>Promise<unknown>
}
/** conflict：本人已有内容不同的同名方法，未另装、未覆盖，需本人处理后再添加。 */
export type CatalogEmployeeResourceState='done'|'pending'|'failed'|'conflict'|'needs-user'|'optional'
export type CatalogEmployeeResource={kind:string;title:string;state:CatalogEmployeeResourceState;nativeName?:string}
/** next：resume 员工已完整就绪、保持暂停待本人恢复；connect 还有连接待本人授权；retry 有资源未完成，可再次添加续做；review 员工已存在但方法与固定包不一致，请本人检查。 */
export type CatalogEmployeeNext='resume'|'connect'|'retry'|'review'
export type CatalogEmployeeReceipt={roleId:string|null;status:'created'|'existing'|'pending';skills:string[];install:{complete:boolean;loadId:string;roleState:string|null;next:CatalogEmployeeNext|null;resources:CatalogEmployeeResource[]}}
/** 旧 v1 回执：原三键形状不变。 */
export type LegacyCatalogRoleReceipt={roleId:string;status:'created'|'existing';skills:string[]}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** 与另一路并发推进同一加载时等它落定的上限：处理中项与摘要冲突同一口径（一键准备自身等待上限 20 秒）；员工已建而方法尚未绑定只是几次查询的间隙。 */
const SETTLE_MS=20000,BIND_MS=3000,POLL_MS=200
const hostBad=()=>new WorkError('teloa/invalid-host-response','员工安装读取到的服务回应格式不正确。')
const lower=(value:unknown)=>typeof value==='string'?value.toLowerCase():''
function derivedId(parts:string[]):string{
 const h=createHash('sha256').update(parts.join('\0')).digest('hex')
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}
type LoadItem={instanceId:string;kind:string;title:string;status:string}
function readLoad(value:unknown):{id:string;items:LoadItem[];relations:{kind:string;from:string;to:string}[]}{
 if(!isRecord(value)||typeof value.id!=='string'||!UUID.test(value.id)||!Array.isArray(value.items)||!Array.isArray(value.relations))throw hostBad()
 const items=value.items.map(item=>{if(!isRecord(item)||typeof item.instanceId!=='string'||typeof item.kind!=='string'||typeof item.title!=='string'||typeof item.status!=='string')throw hostBad();return {instanceId:item.instanceId.toLowerCase(),kind:item.kind,title:item.title,status:item.status}})
 const relations=value.relations.map(link=>{if(!isRecord(link)||typeof link.kind!=='string'||typeof link.from!=='string'||typeof link.to!=='string')throw hostBad();return {kind:link.kind,from:link.from.toLowerCase(),to:link.to.toLowerCase()}})
 return {id:value.id.toLowerCase(),items,relations}
}
type Row={itemInstanceId:string;kind:string;title:string;state:string;entry:string|null}
function readReadiness(value:unknown):{digest:string;auto:number;rows:Row[]}{
 if(!isRecord(value)||typeof value.digest!=='string'||!isRecord(value.counts)||!Number.isSafeInteger(value.counts.auto)||!Array.isArray(value.rows))throw hostBad()
 const rows=value.rows.map(row=>{if(!isRecord(row)||typeof row.itemInstanceId!=='string'||typeof row.kind!=='string'||typeof row.title!=='string'||typeof row.state!=='string'||(row.entry!==null&&typeof row.entry!=='string'))throw hostBad();return {itemInstanceId:row.itemInstanceId.toLowerCase(),kind:row.kind,title:row.title,state:row.state,entry:row.entry as string|null}})
 return {digest:value.digest,auto:Number(value.counts.auto),rows}
}
/** 已装方法与本加载条目的预览是否同一份固定方法：行业来源、同资源标识与版本、同字节摘要、同原生正文与信任说明。 */
function equivalentMethod(row:Record<string,unknown>,preview:Record<string,unknown>):boolean{
 const a=isRecord(row.source)?row.source:{},b=isRecord(preview.source)?preview.source:{},an=isRecord(row.native)?row.native:{},bn=isRecord(preview.native)?preview.native:{}
 return a.kind!=='atomic'&&b.kind!=='atomic'&&a.resourceId===b.resourceId&&a.resourceVersion===b.resourceVersion&&row.bundleHash===preview.bundleHash&&row.trustHash===preview.trustHash&&an.bodyHash===bn.bodyHash
}
/** 清单行映射为员工资源状态：连接已登记、只差本人授权的算 needs-user；扩展未装、资料失败等如实保留。 */
function resourceState(row:Row):CatalogEmployeeResourceState{
 if(row.state==='ready')return 'done'
 if(row.state==='optional')return 'optional'
 if(row.state==='needs-user')return row.entry==='connector-settings'||row.entry==='model-settings'?'needs-user':row.entry==='plugin'?'pending':'failed'
 return 'pending'
}

export function createCatalogEmployeeInstaller(owner:string,get:()=>Promise<CatalogEmployeePorts>){
 // 同一条目版本串行：并发添加共用一次执行，只建一位员工。
 const lanes=new Map<string,Promise<CatalogEmployeeReceipt|LegacyCatalogRoleReceipt>>()
 const run=async(ports:CatalogEmployeePorts,entry:MarketCatalogRoleEntry):Promise<CatalogEmployeeReceipt|LegacyCatalogRoleReceipt>=>{
  const at=await ports.locate(entry)
  if(at.legacyRoleId)return {roleId:at.legacyRoleId,status:'existing',skills:[...entry.role.skills]}
  const id=(...parts:string[])=>derivedId(['teloa-catalog-employee/v1',owner,entry.id,entry.version,String(at.generation),...parts])
  let loadId=at.loadId
  if(!loadId){
   const content=await ports.importContent({requestId:id('content'),entryId:entry.id,generation:at.generation})
   const space=await ports.currentSpace()
   loadId=readLoad(await ports.loads('industry-loads/create',{requestId:id('load',space.id,String(space.version)),contentId:content.id,contentHash:content.hash,target:{kind:'existing',spaceId:space.id,expectedVersion:space.version}})).id
  }
  const load=readLoad(await ports.loads('industry-loads/get',{loadId}))
  const roleItems=load.items.filter(item=>item.kind==='role')
  if(roleItems.length!==1)throw new WorkError('teloa/source-unavailable','员工模板必须恰好包含一位员工。')
  const roleItem=roleItems[0]!,live=(item:LoadItem|undefined):item is LoadItem=>!!item&&item.status!=='skipped'&&item.status!=='detached'
  const methods=load.relations.filter(link=>link.kind==='role-skill'&&link.from===roleItem.instanceId).map(link=>load.items.find(item=>item.instanceId===link.to)).filter(live)
  // 方法：本加载条目已装好的安装登记即沿用；否则预览后按派生请求 id 安装，回执给出实际原生名（不以资源 id 冒充原生名）。
  // 登记仍在处理中（另一路正在发布方法文件，或上次中断）也走安装：安装服务按请求幂等，并在发布锁内等对方落定或续做发布，不把对方的中间态当作本次结果。
  const listed=await ports.skills('skill-installations/list',{})
  if(!isRecord(listed)||!Array.isArray(listed.items)||!Array.isArray(listed.usages))throw hostBad()
  const installs=new Map<string,{state:CatalogEmployeeResourceState;nativeName?:string}>()
  const nativeOf=(row:Record<string,unknown>)=>isRecord(row.native)&&typeof row.native.name==='string'?row.native.name:undefined
  for(const method of methods){
   const usage=listed.usages.filter(isRecord).find(use=>lower(use.loadId)===load.id&&lower(use.itemInstanceId)===method.instanceId)
   const found=usage?listed.items.filter(isRecord).find(row=>lower(row.id)===lower(usage.installationId)):undefined
   if(found&&found.state==='installed'){const name=nativeOf(found);installs.set(method.instanceId,name?{state:'done',nativeName:name}:{state:'pending'});continue}
   try{
    const source={kind:'industry',loadId:load.id,itemInstanceId:method.instanceId}
    const preview=await ports.skills('skill-installations/preview',{source})
    if(!isRecord(preview)||typeof preview.bundleHash!=='string'||preview.trustHash!==undefined&&typeof preview.trustHash!=='string'||!isRecord(preview.native)||!isRecord(preview.source))throw hostBad()
    // 同名方法：本人已有等价安装（同资源与版本、字节摘要、正文与信任说明）时由安装服务直接共用；只有不等价的同名安装时明确冲突，不另装、不覆盖本人已有的那份
    const previewName=preview.native.name,same=listed.items.filter(isRecord).filter(row=>nativeOf(row)===previewName)
    if(same.length&&!same.some(row=>equivalentMethod(row,preview))){installs.set(method.instanceId,{state:'conflict'});continue}
    const result=await ports.skills('skill-installations/install',{requestId:id('skill',method.instanceId),source,expectedBundleHash:preview.bundleHash,...(typeof preview.trustHash==='string'?{expectedTrustHash:preview.trustHash}:{})})
    if(!isRecord(result)||!isRecord(result.installation))throw hostBad()
    const name=nativeOf(result.installation)
    installs.set(method.instanceId,result.installation.state==='installed'&&name?{state:'done',nativeName:name}:{state:'pending'})
   }catch(error){if(error instanceof WorkError&&error.code==='teloa/invalid-host-response')throw error;installs.set(method.instanceId,{state:'failed'})}
  }
  // 方法全部装好才建员工：员工首建即可绑定实际原生名，不留空方法员工。
  // 另一路（另一服务实例或进程；同一安装器内已由 lanes 串行）可能正推进同一加载：prepare 遇摘要冲突、清单里仍有处理中项、
  // 员工已建而方法尚未绑定，都是对方的中间态。有界地续做并重读到落定，不把中间态当作本次回执；超时才如实回 pending 或待检查。
  const names=methods.map(method=>installs.get(method.instanceId)?.nativeName),methodsDone=methods.every(method=>installs.get(method.instanceId)?.state==='done')
  const settleUntil=Date.now()+SETTLE_MS
  let bindUntil:number|undefined
  let readiness=readReadiness(await ports.prepare('industry-loads/readiness',{loadId:load.id},{activate:false})),conflicted=false,executed=false
  let role:Record<string,unknown>|undefined
  for(;;){
   if(methodsDone&&readiness.auto>0){
    try{await ports.prepare('industry-loads/prepare',{loadId:load.id,expectedDigest:readiness.digest},{activate:false});conflicted=false;executed=true}
    catch(error){if(!(error instanceof WorkError&&['teloa/version-conflict','teloa/conflict'].includes(error.code)))throw error;conflicted=true}
    readiness=readReadiness(await ports.prepare('industry-loads/readiness',{loadId:load.id},{activate:false}))
   }
   const listedRoles=await ports.roles('industry-roles/list',{})
   if(!isRecord(listedRoles)||!Array.isArray(listedRoles.items))throw hostBad()
   const instance=listedRoles.items.filter(isRecord).find(row=>lower(row.loadId)===load.id&&lower(row.itemInstanceId)===roleItem.instanceId)
   role=instance&&isRecord(instance.role)?instance.role:undefined
   if(role&&(typeof role.id!=='string'||!UUID.test(role.id)||typeof role.state!=='string'||!Array.isArray(role.skills)||role.skills.some(name=>typeof name!=='string')))throw hostBad()
   const now=Date.now(),skills=role?role.skills as string[]:[]
   // 对方仍在推进：摘要冲突后仍有可自动项、或清单有处理中项；对方刚建好首版员工、尚未绑定方法（本次已执行过准备的不等：绑定缺口是真缺口）。
   const peerBusy=(conflicted&&readiness.auto>0||readiness.rows.some(row=>row.state==='pending'))&&now<settleUntil
   const unbound=!executed&&methodsDone&&!!role&&role.version===1&&!names.every(name=>name!==undefined&&skills.includes(name))
   // 绑定窗口自首次看到未绑定的首版员工起算：此前等对方准备资料与建员工的耗时不吃掉它。
   const peerBinding=unbound&&now<(bindUntil??=now+BIND_MS)
   if(!peerBusy&&!peerBinding)break
   await new Promise<void>(resolve=>setTimeout(resolve,POLL_MS))
   readiness=readReadiness(await ports.prepare('industry-loads/readiness',{loadId:load.id},{activate:false}))
  }
  const roleId=role?String(role.id).toLowerCase():null,bound=role?role.skills as string[]:[]
  const resources:CatalogEmployeeResource[]=readiness.rows.filter(row=>row.itemInstanceId!==roleItem.instanceId).map(row=>{
   const install=installs.get(row.itemInstanceId),state=install?.state==='failed'||install?.state==='conflict'?install.state:resourceState(row)
   return {kind:row.kind,title:row.title,state,...(install?.nativeName?{nativeName:install.nativeName}:{})}
  })
  const methodsBound=names.every(name=>name!==undefined&&bound.includes(name))
  const installed=roleId!==null&&resources.every(row=>row.state==='done'||row.state==='optional'||row.state==='needs-user')
  const complete=installed&&methodsBound
  const next:CatalogEmployeeNext|null=resources.some(row=>row.state==='conflict')?'review':!installed?'retry':!methodsBound?'review':resources.some(row=>row.state==='needs-user')?'connect':role?.state==='paused'?'resume':null
  return {roleId,status:roleId===null?'pending':at.roleId?'existing':'created',skills:[...bound],install:{complete,loadId:load.id,roleState:role?String(role.state):null,next,resources}}
 }
 return async(input:{entryId:string;version:string}):Promise<CatalogEmployeeReceipt|LegacyCatalogRoleReceipt>=>{
  if(typeof owner!=='string'||!owner.trim())throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const ports=await get(),entry=ports.entry(input.entryId)
  if(input.version!==entry.version)throw new WorkError('teloa/version-conflict','目录条目已更新，请重新预览后再添加。')
  const key=entry.id+'@'+entry.version
  const previous=lanes.get(key)
  const running=(previous?previous.catch(()=>undefined):Promise.resolve()).then(()=>run(ports,entry))
  lanes.set(key,running)
  void running.catch(()=>undefined).finally(()=>{if(lanes.get(key)===running)lanes.delete(key)})
  return running
 }
}
