import {WorkError} from './work-error.ts'

/**
 * `installed-pending-enable`：包已装进 profile，但**不在** `dsh.profile.bundles` 里 ——
 * 它的组合补丁层在本人显式启用前完全不参与组合，重启也不会加载它的代码。
 * `installed-restart-required`：已启用、已在 bundles 里，等下一次重启生效。
 */
export const marketPluginInstallationStates=['preparing','installed-pending-enable','installed-active','installed-restart-required','failed','unknown'] as const
export type MarketPluginInstallationState=(typeof marketPluginInstallationStates)[number]

export type MarketPluginRegistrySource={registry:'npm';packageName:string;version:string}
export type MarketPluginTrust={status:'verified'|'unverified'|'rejected';publisher:string;integrity:string}
export type MarketPluginPermissionSummary={permissions:{id:string;description:string;required:boolean}[]}
export type MarketPluginInstallPreview={
 schema:'teloa.market-plugin-install-preview/v1'
 source:MarketPluginRegistrySource
 trust:MarketPluginTrust
 bundleHash:string
 permissionSummary:MarketPluginPermissionSummary
}
/**
 * `action` 省略即 `install`。`enable` 是"已安装 · 待启用"的显式放行动作：
 * 安装只把包装进 profile，包名**不进** `dsh.profile.bundles`，它的组合补丁层在启用前完全不参与组合；
 * 本人确认后才把包名加回 bundles，下次启动生效。
 */
export type MarketPluginInstallSpec={schema:'teloa.market-plugin-install-spec/v1';requestId:string;preview:MarketPluginInstallPreview;action?:'install'|'enable'}
export type MarketPluginInstallFailure={code:'install-failed'|'install-unknown'|'observation-unavailable'|'observation-mismatch';message:string;retryable:boolean}
export type MarketPluginInstallReceipt=
 | {schema:'teloa.market-plugin-install-receipt/v1';outcome:'succeeded'}
 | {schema:'teloa.market-plugin-install-receipt/v1';outcome:'failed'|'unknown';failure:MarketPluginInstallFailure}
export type MarketPluginInstallObservation=
 | {schema:'teloa.market-plugin-install-observation/v1';status:'active'|'restart-required'|'pending-enable';source:MarketPluginRegistrySource;bundleHash:string;permissionSummary:MarketPluginPermissionSummary}
 | {schema:'teloa.market-plugin-install-observation/v1';status:'absent'|'unknown';failure:MarketPluginInstallFailure}

const bad=()=>new WorkError('teloa/invalid-input','DSH 扩展安装合同格式不正确或包含未知字段。')
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!record(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw bad()
 return value
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const exactVersion=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
const packageName=(value:unknown):value is string=>typeof value==='string'&&value.length<=214&&/^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value)&&!value.endsWith('.tgz')
const nonBlank=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()

function readSource(value:unknown):MarketPluginRegistrySource{
 const row=exact(value,['registry','packageName','version'])
 if(row.registry!=='npm'||!packageName(row.packageName)||!exactVersion(row.version))throw bad()
 return {registry:'npm',packageName:row.packageName,version:row.version}
}

function readTrust(value:unknown):MarketPluginTrust{
 const row=exact(value,['status','publisher','integrity'])
 if(!['verified','unverified','rejected'].includes(String(row.status))||!nonBlank(row.publisher,200)||typeof row.integrity!=='string'||row.integrity.length>1000||!/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(row.integrity))throw bad()
 return {status:row.status as MarketPluginTrust['status'],publisher:row.publisher,integrity:row.integrity}
}

/**
 * 权限说明文字由权限 id 决定，只用于展示：识别不了的 id 返回 undefined，调用方退回记录里的原文。
 * 旧版本存进安装记录的说明（例如「该插件会新增…」）以这里的当前文案展示。
 */
export function marketPluginPermissionDescription(id:string):string|undefined{
 if(id==='dsh.bundle')return '将加载 DSH 宿主配置层。'
 if(id==='dsh.bundle.unverifiable')return '该扩展的 DSH 组合补丁无法逐行核验，可能改动任意部署配置。'
 const [kind,name]=[id.slice(0,id.indexOf(':')),id.slice(id.indexOf(':')+1)]
 if(!id.includes(':')||!name)return undefined
 if(kind==='dsh.bundle.insert')return '该扩展会新增 DSH 组合配置行 '+name+'。'
 if(kind==='dsh.bundle.patch')return '该扩展会改动 DSH 组合配置行 '+name+'。'
 if(kind==='dsh.client')return '将加载 DSH '+name+' 客户端代码。'
 if(kind==='dsh.config-tree')return '将加载 DSH 配置树 '+name+'。'
 return undefined
}

/**
 * 能力摘要比对只看每项的 id 与 required：说明文字由 id 决定、会随界面用词调整，
 * 逐字比它会让改版前已安装的扩展在启用、核对、重装时被误判为「权限已变化」。
 */
export function marketPluginPermissionKey(summary:MarketPluginPermissionSummary):string{
 return JSON.stringify([...summary.permissions].map(item=>[item.id,item.required]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))
}
export function sameMarketPluginPermissions(left:MarketPluginPermissionSummary,right:MarketPluginPermissionSummary):boolean{
 return marketPluginPermissionKey(left)===marketPluginPermissionKey(right)
}

function readPermissionSummary(value:unknown):MarketPluginPermissionSummary{
 const row=exact(value,['permissions'])
 if(!Array.isArray(row.permissions)||row.permissions.length>100)throw bad()
 const permissions=row.permissions.map(input=>{
  const permission=exact(input,['id','description','required'])
  if(typeof permission.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(permission.id)||!nonBlank(permission.description,500)||typeof permission.required!=='boolean')throw bad()
  return {id:permission.id,description:permission.description,required:permission.required}
 })
 if(new Set(permissions.map(permission=>permission.id)).size!==permissions.length)throw bad()
 return {permissions}
}

function readFailure(value:unknown):MarketPluginInstallFailure{
 const row=exact(value,['code','message','retryable'])
 if(!['install-failed','install-unknown','observation-unavailable','observation-mismatch'].includes(String(row.code))||!nonBlank(row.message,1000)||typeof row.retryable!=='boolean')throw bad()
 return {code:row.code as MarketPluginInstallFailure['code'],message:row.message,retryable:row.retryable}
}

export function readMarketPluginInstallationState(value:unknown):MarketPluginInstallationState{
 if(!marketPluginInstallationStates.includes(value as MarketPluginInstallationState))throw bad()
 return value as MarketPluginInstallationState
}

export function readMarketPluginRegistrySource(value:unknown):MarketPluginRegistrySource{return readSource(value)}

export function marketPluginPackageRef(value:MarketPluginRegistrySource):string{
 const source=readSource(value)
 return source.packageName+'@'+source.version
}

export function readMarketPluginInstallPreview(value:unknown):MarketPluginInstallPreview{
 const row=exact(value,['schema','source','trust','bundleHash','permissionSummary'])
 if(row.schema!=='teloa.market-plugin-install-preview/v1'||!hex(row.bundleHash))throw bad()
 return {schema:'teloa.market-plugin-install-preview/v1',source:readSource(row.source),trust:readTrust(row.trust),bundleHash:row.bundleHash,permissionSummary:readPermissionSummary(row.permissionSummary)}
}

export function readMarketPluginInstallSpec(value:unknown):MarketPluginInstallSpec{
 const row=exact(value,record(value)&&'action' in value?['schema','requestId','preview','action']:['schema','requestId','preview'])
 if(row.schema!=='teloa.market-plugin-install-spec/v1'||!uuid(row.requestId))throw bad()
 if(row.action!==undefined&&row.action!=='install'&&row.action!=='enable')throw bad()
 return {schema:'teloa.market-plugin-install-spec/v1',requestId:row.requestId.toLowerCase(),preview:readMarketPluginInstallPreview(row.preview),...(row.action===undefined?{}:{action:row.action as 'install'|'enable'})}
}

export function readMarketPluginInstallFailure(value:unknown):MarketPluginInstallFailure{return readFailure(value)}

export function readMarketPluginInstallReceipt(value:unknown):MarketPluginInstallReceipt{
 if(!record(value)||value.schema!=='teloa.market-plugin-install-receipt/v1')throw bad()
 if(value.outcome==='succeeded'){
  exact(value,['schema','outcome'])
  return {schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded'}
 }
 if(value.outcome==='failed'||value.outcome==='unknown'){
  exact(value,['schema','outcome','failure'])
  const failure=readFailure(value.failure)
  if(value.outcome==='failed'&&failure.code!=='install-failed'||value.outcome==='unknown'&&failure.code!=='install-unknown')throw bad()
  return {schema:'teloa.market-plugin-install-receipt/v1',outcome:value.outcome,failure}
 }
 throw bad()
}

export function readMarketPluginInstallObservation(value:unknown):MarketPluginInstallObservation{
 if(!record(value)||value.schema!=='teloa.market-plugin-install-observation/v1')throw bad()
 if(value.status==='active'||value.status==='restart-required'||value.status==='pending-enable'){
  const row=exact(value,['schema','status','source','bundleHash','permissionSummary'])
  if(!hex(row.bundleHash))throw bad()
  return {schema:'teloa.market-plugin-install-observation/v1',status:value.status,source:readSource(row.source),bundleHash:row.bundleHash,permissionSummary:readPermissionSummary(row.permissionSummary)}
 }
 if(value.status==='absent'||value.status==='unknown'){
  const row=exact(value,['schema','status','failure'])
  const failure=readFailure(row.failure)
  if(value.status==='absent'&&failure.code!=='observation-mismatch'||value.status==='unknown'&&failure.code!=='observation-unavailable')throw bad()
  return {schema:'teloa.market-plugin-install-observation/v1',status:value.status,failure}
 }
 throw bad()
}
