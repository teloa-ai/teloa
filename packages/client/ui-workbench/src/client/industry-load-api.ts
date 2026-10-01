import {industryResourceModelDependencies,readIndustryModelObservations,type IndustryModelObservation,type IndustryModelDependency,readIndustryUpdateChoices,type IndustryUpdateChoices} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'
type Call=(method:string,payload:unknown)=>Promise<unknown>
export type IndustryLoadStatus='active'|'unloaded'|'superseded'
/** 继任加载的升级血缘：被替代的加载、它的模板版本，以及当时固定下来的升级计划。 */
export type IndustryLoadUpgrade={loadId:string;templateVersion:string;choices:IndustryUpdateChoices;diffDigest:string;createdAt:string}
export type IndustryLoadRecord={id:string;ownerId:string;contentId:string;contentHash:string;templateId:string;templateVersion:string;templateTitle:string;domain:string;scope:string;description:string;targetVersion:number;space:{id:string;name:string;version:number;scope:string};items:Array<{localId:string;instanceId:string;kind:typeof kinds[number];title:string;version:string;required:boolean;status:'pending-adapter'|'skipped'|'instantiated'|'active'|'detached';carriedFrom?:string;modelDependencies?:IndustryModelDependency[]}>;relations:Array<{kind:string;from:string;to:string}>;entrypoints:string[];createdAt:string;mappingHash:string;status:IndustryLoadStatus;unloadedAt?:string;upgrade?:IndustryLoadUpgrade}
export type IndustryLoadCreateInput={requestId:string;contentId:string;contentHash:string;target:{kind:'new';spaceId:string;name:string}|{kind:'existing';spaceId:string;expectedVersion:number}}
export type IndustryLoadUnloadInput={requestId:string;loadId:string;expectedMappingHash:string}
export type IndustryLoadUpgradeInput={requestId:string;loadId:string;candidateContentId:string;expectedMappingHash:string;choices:IndustryUpdateChoices}
export type IndustryLoadUpgradeResult={superseded:IndustryLoadRecord;successor:IndustryLoadRecord}
/** 卸载被拒绝时宿主回报的在途事实，界面据此列出先要收尾的执行。 */
export type IndustryLoadUnloadBlocker={kind:'plan-occurrence'|'task-run';id:string}
export type IndustryLoadJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
const kinds=['role','knowledge','skill','mcp','plugin','data-source','execution-tool','work-template','plan','object-type','business-view','business-action'] as const
const statuses=['pending-adapter','skipped','instantiated','active','detached'] as const
const loadStatuses=['active','unloaded','superseded'] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const exact=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value as Record<string,unknown>}

function request(value:unknown):IndustryLoadCreateInput{
 try{
  const row=exact(value,['requestId','contentId','contentHash','target']),target=exact(row.target,['kind','spaceId','name','expectedVersion'])
  if(!uuid(row.requestId)||!uuid(row.contentId)||!hash(row.contentHash)||!uuid(target.spaceId))throw Error()
  if(target.kind==='new'){exact(target,['kind','spaceId','name']);if(!text(target.name,80))throw Error();return {requestId:row.requestId,contentId:row.contentId,contentHash:row.contentHash,target:{kind:'new',spaceId:target.spaceId,name:target.name.trim()}}}
  if(target.kind==='existing'){exact(target,['kind','spaceId','expectedVersion']);if(!positive(target.expectedVersion))throw Error();return {requestId:row.requestId,contentId:row.contentId,contentHash:row.contentHash,target:{kind:'existing',spaceId:target.spaceId,expectedVersion:target.expectedVersion}}}
  throw Error()
 }catch{throw Error('行业模板加载请求格式不正确。')}
}

function unloadRequest(value:unknown):IndustryLoadUnloadInput{
 try{
  const row=exact(value,['requestId','loadId','expectedMappingHash'])
  if(!uuid(row.requestId)||!uuid(row.loadId)||!hash(row.expectedMappingHash))throw Error()
  return {requestId:row.requestId,loadId:row.loadId,expectedMappingHash:row.expectedMappingHash}
 }catch{throw Error('行业模板卸载请求格式不正确。')}
}

function upgradeRequest(value:unknown):IndustryLoadUpgradeInput{
 try{
  const row=exact(value,['requestId','loadId','candidateContentId','expectedMappingHash','choices'])
  if(!uuid(row.requestId)||!uuid(row.loadId)||!uuid(row.candidateContentId)||!hash(row.expectedMappingHash))throw Error()
  return {requestId:row.requestId,loadId:row.loadId,candidateContentId:row.candidateContentId,expectedMappingHash:row.expectedMappingHash,choices:readIndustryUpdateChoices(row.choices)}
 }catch{throw Error('行业模板升级请求格式不正确。')}
}

function record(value:unknown):IndustryLoadRecord{
 try{
  const row=exact(value,['id','ownerId','contentId','contentHash','templateId','templateVersion','templateTitle','domain','scope','description','targetVersion','space','items','relations','entrypoints','createdAt','mappingHash','status','unloadedAt','upgrade'])
  if(!uuid(row.id)||!text(row.ownerId,128)||!uuid(row.contentId)||!hash(row.contentHash)||!id(row.templateId)||!semver(row.templateVersion)||!text(row.templateTitle,120)||!text(row.domain,80)||!text(row.scope,80)||typeof row.description!=='string'||row.description.length>2000||!positive(row.targetVersion)||typeof row.createdAt!=='string'||new Date(row.createdAt).toISOString()!==row.createdAt)throw Error()
  // 卸载时刻只出现在已卸载的加载上，且不能早于加载时刻。
  if(!hash(row.mappingHash)||!loadStatuses.includes(row.status as typeof loadStatuses[number]))throw Error()
  if(row.status==='unloaded'){if(typeof row.unloadedAt!=='string'||new Date(row.unloadedAt).toISOString()!==row.unloadedAt||row.unloadedAt<row.createdAt)throw Error()}else if(row.unloadedAt!==undefined)throw Error()
  // 升级血缘只出现在继任加载上，四个字段缺一不可，且不能指向自己。
  const upgrade=row.upgrade===undefined?undefined:exact(row.upgrade,['loadId','templateVersion','choices','diffDigest','createdAt'])
  if(upgrade){
   if(!uuid(upgrade.loadId)||upgrade.loadId===row.id||!semver(upgrade.templateVersion)||!hash(upgrade.diffDigest)||typeof upgrade.createdAt!=='string'||new Date(upgrade.createdAt).toISOString()!==upgrade.createdAt||upgrade.createdAt<(row.createdAt as string))throw Error()
   readIndustryUpdateChoices(upgrade.choices)
  }
  // `space.scope` 与加载的 scope 都是业务范围标签，不再由空间身份拼出。
  const space=exact(row.space,['id','name','version','scope']);if(!uuid(space.id)||!text(space.name,80)||!positive(space.version)||!text(space.scope,80))throw Error()
  if(space.scope!==row.scope)throw Error()
  if((row.targetVersion as number)>(space.version as number))throw Error()
  if(!Array.isArray(row.items)||!row.items.length||row.items.length>500)throw Error()
  const items=row.items.map(value=>{const item=exact(value,['localId','instanceId','kind','title','version','required','status','carriedFrom','modelDependencies']);if(!id(item.localId)||!uuid(item.instanceId)||!kinds.includes(item.kind as typeof kinds[number])||!text(item.title,120)||!semver(item.version)||typeof item.required!=='boolean'||!statuses.includes(item.status as typeof statuses[number])||item.required&&item.status==='skipped')throw Error();if(item.carriedFrom!==undefined&&(!upgrade||!uuid(item.carriedFrom)))throw Error();industryResourceModelDependencies(item.kind,item.modelDependencies);return item})
  if(new Set(items.map(item=>item.localId)).size!==items.length||new Set(items.map(item=>item.instanceId)).size!==items.length)throw Error()
  const carried=items.flatMap(item=>item.carriedFrom===undefined?[]:[item.carriedFrom as string])
  if(new Set(carried).size!==carried.length||carried.some(value=>items.some(item=>item.instanceId===value)))throw Error()
  const instances=new Set(items.map(item=>item.instanceId))
  if(!Array.isArray(row.relations)||row.relations.length>2000)throw Error()
  const relations=row.relations.map(value=>{const relation=exact(value,['kind','from','to']);if(!text(relation.kind,80)||!uuid(relation.from)||!uuid(relation.to)||!instances.has(relation.from)||!instances.has(relation.to))throw Error();return relation})
  if(!Array.isArray(row.entrypoints)||row.entrypoints.length>500||row.entrypoints.some(value=>!uuid(value)||!instances.has(value))||new Set(row.entrypoints).size!==row.entrypoints.length)throw Error()
  return row as unknown as IndustryLoadRecord
 }catch{throw Error('行业模板加载记录格式不正确。')}
}

/**
 * 从宿主拒绝里读出卸载阻塞项：只接受 `teloa/conflict` 的既定两类在途事实，其余一律当作没有阻塞项。
 * 读不出的形状不报错——界面回退到普通错误提示，不因附加事实格式不对而遮蔽原始拒绝原因。
 */
export function readUnloadBlockers(reason:unknown):IndustryLoadUnloadBlocker[]{
 if(!reason||typeof reason!=='object'||!('code' in reason)||reason.code!=='teloa/conflict'||!('details' in reason))return []
 const details=(reason as {details?:unknown}).details
 if(!details||typeof details!=='object'||!('blockers' in details))return []
 const blockers=(details as {blockers?:unknown}).blockers
 if(!Array.isArray(blockers)||blockers.length>100)return []
 const found:IndustryLoadUnloadBlocker[]=[]
 for(const item of blockers){
  if(!item||typeof item!=='object'||!('kind' in item)||!('id' in item))return []
  const {kind,id:value}=item as {kind:unknown;id:unknown}
  if(kind!=='plan-occurrence'&&kind!=='task-run'||!uuid(value))return []
  found.push({kind,id:value})
 }
 return found
}

// 方案一键准备（规格 2026-09-26-方案一键准备 §7）：客户端只提交加载身份与本人确认过的摘要；分类、摘要、子请求身份一律由宿主判定。
/** trust 只出现在随一键安装、带信任声明的技能行上（官方目录已审核、纯内容、无联网或执行权限）。 */
export type IndustryReadinessRow={itemInstanceId:string;kind:string;title:string;state:'ready'|'auto'|'needs-user'|'optional'|'pending';step:string|null;entry:'model-settings'|'connector-settings'|'skill-confirm'|'plugin'|'knowledge-retry'|'role-retry'|'role-resume'|'task-form'|'plan-form'|null;trust?:{publisher:string;license:string|null};models?:IndustryModelObservation[]}
export type IndustryReadiness={loadId:string;status:IndustryLoadStatus;title:string;version:string;digest:string;counts:{ready:number;auto:number;needsUser:number;optional:number;pending:number};rows:IndustryReadinessRow[]}
export type IndustryPrepareResult={itemInstanceId:string;title:string;step:string;outcome:'done'|'pending'|'failed'|'skipped';code:string|null;message:string|null}
/** readiness 为 null：宿主已执行，但最终清单读取失败、待刷新。 */
export type IndustryPrepareReceipt={loadId:string;digest:string;results:IndustryPrepareResult[];readiness:IndustryReadiness|null}
const readinessStates=['ready','auto','needs-user','optional','pending'],readinessEntries=['model-settings','connector-settings','skill-confirm','plugin','knowledge-retry','role-retry','role-resume','task-form','plan-form'],prepareOutcomes=['done','pending','failed','skipped']
function readinessRecord(value:unknown):IndustryReadiness{
 try{
  const row=exact(value,['loadId','status','title','version','digest','counts','rows']),counts=exact(row.counts,['ready','auto','needsUser','optional','pending'])
  if(!uuid(row.loadId)||!(loadStatuses as readonly unknown[]).includes(row.status)||typeof row.title!=='string'||typeof row.version!=='string'||!hash(row.digest)||!Array.isArray(row.rows)||Object.keys(counts).length!==5||!Object.values(counts).every(v=>Number.isSafeInteger(v)&&Number(v)>=0))throw Error()
  const rows=row.rows.map(item=>{const r=exact(item,['itemInstanceId','kind','title','state','step','entry','trust','models']);if(r.models!==undefined)readIndustryModelObservations(r.models);if(r.trust!==undefined){const trust=exact(r.trust,['publisher','license']);if(typeof trust.publisher!=='string'||(trust.license!==null&&typeof trust.license!=='string'))throw Error()}if(!uuid(r.itemInstanceId)||typeof r.kind!=='string'||typeof r.title!=='string'||!readinessStates.includes(String(r.state))||(r.step!==null&&typeof r.step!=='string')||(r.entry!==null&&!readinessEntries.includes(String(r.entry))))throw Error();return r as unknown as IndustryReadinessRow})
  return {loadId:row.loadId.toLowerCase(),status:row.status as IndustryLoadStatus,title:row.title,version:row.version,digest:row.digest,counts:counts as IndustryReadiness['counts'],rows}
 }catch{throw Error('准备清单格式不正确。')}
}
function prepareReceipt(value:unknown):IndustryPrepareReceipt{
 let row:Record<string,unknown>
 try{row=exact(value,['loadId','digest','results','readiness']);if(!uuid(row.loadId)||!hash(row.digest)||!Array.isArray(row.results))throw Error()}catch{throw Error('准备回执格式不正确。')}
 const results=(row.results as unknown[]).map(item=>{try{const r=exact(item,['itemInstanceId','title','step','outcome','code','message']);if(!uuid(r.itemInstanceId)||typeof r.title!=='string'||typeof r.step!=='string'||!prepareOutcomes.includes(String(r.outcome))||(r.code!==null&&!/^teloa\/[a-z0-9-]+$/.test(String(r.code)))||(r.message!==null&&typeof r.message!=='string'))throw Error();return r as unknown as IndustryPrepareResult}catch{throw Error('准备回执格式不正确。')}})
 return {loadId:String(row.loadId).toLowerCase(),digest:String(row.digest),results,readiness:row.readiness===null?null:readinessRecord(row.readiness)}
}

export type IndustryLoadApi=ReturnType<typeof createIndustryLoadApi>
export function createIndustryLoadApi(call:Call,journal?:IndustryLoadJournal,unloadJournal?:IndustryLoadJournal,upgradeJournal?:IndustryLoadJournal){
 let pending:IndustryLoadCreateInput|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 let unloadPending:IndustryLoadUnloadInput|undefined,unloadRecoveryError:ReturnType<typeof recoveryStorageError>|undefined,unloadBusy=false
 let upgradePending:IndustryLoadUpgradeInput|undefined,upgradeRecoveryError:ReturnType<typeof recoveryStorageError>|undefined,upgradeBusy=false
 try{const raw=journal?.read();if(raw){if(raw.length>3000)throw Error();const saved=exact(JSON.parse(raw),['schema','request']);if(saved.schema!=='teloa.industry-load-create/v1')throw Error();pending=request(saved.request)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{if(recoveryError)throw recoveryError;if(!pending)throw Error('没有待核对的行业模板加载请求。');if(busy)throw Error('行业模板加载正在核对。');busy=true;try{journal?.write(JSON.stringify({schema:'teloa.industry-load-create/v1',request:pending}));const result=record(await call('industry-loads/create',pending));if(result.contentId!==pending.contentId||result.contentHash!==pending.contentHash||result.space.id!==pending.target.spaceId)throw Error('行业模板加载响应与原请求不一致。');journal?.clear();pending=undefined;return result}catch(error){if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'].includes(String(error.code))){journal?.clear();pending=undefined}throw error}finally{busy=false}}
 try{const raw=unloadJournal?.read();if(raw){if(raw.length>500)throw Error();const saved=exact(JSON.parse(raw),['schema','request']);if(saved.schema!=='teloa.industry-load-unload/v1')throw Error();unloadPending=unloadRequest(saved.request)}}catch{unloadRecoveryError=recoveryStorageError()}
 const sendUnload=async()=>{if(unloadRecoveryError)throw unloadRecoveryError;if(!unloadPending)throw Error('没有待核对的行业模板卸载请求。');if(unloadBusy)throw Error('行业模板卸载正在核对。');const input=unloadPending;unloadBusy=true;try{unloadJournal?.write(JSON.stringify({schema:'teloa.industry-load-unload/v1',request:input}));const result=record(await call('industry-loads/unload',input));if(result.id!==input.loadId||result.status!=='unloaded')throw Error('行业模板卸载响应与原请求不一致。');unloadJournal?.clear();unloadPending=undefined;return result}catch(error){if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'].includes(String(error.code))){unloadJournal?.clear();unloadPending=undefined}throw error}finally{unloadBusy=false}}
 try{const raw=upgradeJournal?.read();if(raw){if(raw.length>3000)throw Error();const saved=exact(JSON.parse(raw),['schema','request']);if(saved.schema!=='teloa.industry-load-upgrade/v1')throw Error();upgradePending=upgradeRequest(saved.request)}}catch{upgradeRecoveryError=recoveryStorageError()}
 const sendUpgrade=async()=>{if(upgradeRecoveryError)throw upgradeRecoveryError;if(!upgradePending)throw Error('没有待核对的行业模板升级请求。');if(upgradeBusy)throw Error('行业模板升级正在核对。');const input=upgradePending;upgradeBusy=true;try{upgradeJournal?.write(JSON.stringify({schema:'teloa.industry-load-upgrade/v1',request:input}));const response=exact(await call('industry-loads/upgrade',input),['superseded','successor']);const result={superseded:record(response.superseded),successor:record(response.successor)};if(result.superseded.id!==input.loadId||result.superseded.status!=='superseded'||result.successor.status!=='active'||result.successor.contentId!==input.candidateContentId||result.successor.upgrade?.loadId!==input.loadId)throw Error('行业模板升级响应与原请求不一致。');upgradeJournal?.clear();upgradePending=undefined;return result}catch(error){if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'].includes(String(error.code))){upgradeJournal?.clear();upgradePending=undefined}throw error}finally{upgradeBusy=false}}
 return {
  pending:()=>pending?structuredClone(pending):undefined,
  recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  recover:send,
  async create(value:IndustryLoadCreateInput){if(recoveryError)throw recoveryError;const normalized=request(value);if(pending&&JSON.stringify(pending)!==JSON.stringify(normalized))throw Error('请先核对原请求，再更换行业模板或目标空间。');pending??=normalized;return send()},
  unloadPending:()=>unloadPending?structuredClone(unloadPending):undefined,
  unloadRecoveryMessage:()=>unloadRecoveryError,
  /** 丢弃卸载的本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discardUnload(){const had=unloadPending!==undefined||unloadRecoveryError!==undefined;try{unloadJournal?.clear()}catch{/* 清不掉不该变成第二道墙 */}unloadPending=undefined;unloadRecoveryError=undefined;return had},
  recoverUnload:sendUnload,
  /** 卸载只提交请求身份、目标加载与映射指纹；解除范围与阻塞项一律由宿主判定。 */
  async unload(value:IndustryLoadUnloadInput){if(unloadRecoveryError)throw unloadRecoveryError;const normalized=unloadRequest(value);if(unloadPending&&JSON.stringify(unloadPending)!==JSON.stringify(normalized))throw Error('请先核对原请求，再卸载其他行业模板。');unloadPending??=normalized;return sendUnload()},
  upgradePending:()=>upgradePending?structuredClone(upgradePending):undefined,
  upgradeRecoveryMessage:()=>upgradeRecoveryError,
  /** 丢弃升级的本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discardUpgrade(){const had=upgradePending!==undefined||upgradeRecoveryError!==undefined;try{upgradeJournal?.clear()}catch{/* 清不掉不该变成第二道墙 */}upgradePending=undefined;upgradeRecoveryError=undefined;return had},
  recoverUpgrade:sendUpgrade,
  /** 升级只提交请求身份、目标加载、候选内容、映射指纹与处理方式；差异与继任加载一律由宿主判定。 */
  async upgrade(value:IndustryLoadUpgradeInput){if(upgradeRecoveryError)throw upgradeRecoveryError;const normalized=upgradeRequest(value);if(upgradePending&&JSON.stringify(upgradePending)!==JSON.stringify(normalized))throw Error('请先核对原请求，再升级其他行业模板。');upgradePending??=normalized;return sendUpgrade()},
  async get(loadId:string){if(!uuid(loadId))throw Error('行业模板加载身份不正确。');const result=record(await call('industry-loads/get',{loadId}));if(result.id!==loadId)throw Error('行业模板加载响应与目标身份不一致。');return result},
  /** 准备就绪清单：只提交加载身份。 */
  async readiness(loadId:string){if(!uuid(loadId))throw Error('行业模板加载身份不正确。');const result=readinessRecord(await call('industry-loads/readiness',{loadId}));if(result.loadId!==loadId.toLowerCase())throw Error('准备清单与目标加载不一致。');return result},
  /** 一键准备：只提交加载身份与本人确认过的摘要；不传 requestId。 */
  async prepare(loadId:string,expectedDigest:string){if(!uuid(loadId)||!hash(expectedDigest))throw Error('准备请求参数不正确。');const result=prepareReceipt(await call('industry-loads/prepare',{loadId,expectedDigest}));if(result.loadId!==loadId.toLowerCase())throw Error('准备回执与目标加载不一致。');return result},
  async list(includeUnloaded?:boolean){const response=await call('industry-loads/list',includeUnloaded===true?{includeUnloaded:true}:{});let value:Record<string,unknown>;try{value=exact(response,['items']);if(!Array.isArray(value.items))throw Error()}catch{throw Error('行业模板加载目录格式不正确。')}const items=value.items.map(record);if(new Set(items.map(item=>item.id)).size!==items.length)throw Error('行业模板加载目录身份重复。');/** 同一空间下的多个加载各自带自己的业务范围标签，`scope` 因此不参与空间现状的一致性核对。 */
  const spaces=new Map<string,string>();for(const item of items){const snapshot=JSON.stringify({id:item.space.id,name:item.space.name,version:item.space.version}),previous=spaces.get(item.space.id);if(previous&&previous!==snapshot)throw Error('行业模板加载目录中的空间现状不一致。');spaces.set(item.space.id,snapshot)}return items},
 }
}
