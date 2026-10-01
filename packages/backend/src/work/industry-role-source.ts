import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,roleDefinition,type RoleDefinition} from '@teloa/contract'
import {validateManifest,type MarketContentStore} from '../market/content-store.ts'
import type {IndustryLoadService} from './industry-loads.ts'

export type IndustryRoleSnapshot={loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;templateVersion:string;itemVersion:string;fileHash:string;definition:Pick<RoleDefinition,'name'|'kind'|'duty'|'dataScope'|'executionScope'|'responsibility'|'runtimeConfig'>;ignoredModelSelection:boolean}
/**
 * 固定内容里某个岗位资源的模板字段：不含空间范围、能力与知识（那三项由实例化时的加载现场决定）。
 * `ignoredModelSelection`：模板 `runtimeConfig` 带了 `model`/`fallbackModel`（终审 I-2：本期方案包不能指定岗位模型，含 GitHub 导入），已剥离、不应用到岗位，由调用方给出可见提示。
 */
export type IndustryRoleTemplate={fileHash:string;definition:IndustryRoleSnapshot['definition'];ignoredModelSelection:boolean}
const unavailable=(message:string)=>new WorkError('teloa/source-unavailable',message)
const emptyResponsibility={triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}
export class IndustryRoleSource{
 private readonly market:Pick<MarketContentStore,'get'|'getInTransaction'>
 private readonly loads:Pick<IndustryLoadService,'get'|'storedItemStatus'>
 constructor(market:Pick<MarketContentStore,'get'|'getInTransaction'>,loads:Pick<IndustryLoadService,'get'|'storedItemStatus'>){this.market=market;this.loads=loads}
 async read(db:Pool|PoolClient,owner:string,loadId:string,itemInstanceId:string):Promise<IndustryRoleSnapshot>{
  const load=await this.loads.get(owner,{loadId}),item=load.items.find(row=>row.instanceId===itemInstanceId)
  if(!item||item.kind!=='role'||await this.loads.storedItemStatus(db,owner,item.instanceId)!=='pending-adapter')throw unavailable('目标不是可实例化的行业员工。')
  const template=await this.readTemplate(owner,{contentId:load.contentId,contentHash:load.contentHash,itemLocalId:item.localId,itemVersion:item.version})
  return {loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,templateVersion:load.templateVersion,itemVersion:item.version,fileHash:template.fileHash,definition:template.definition,ignoredModelSelection:template.ignoredModelSelection}
 }
 /**
  * 只按固定内容读出岗位模板字段：不需要加载记录，因此升级时也能读候选版本的岗位定义。
  * 判据与 `read` 完全一致（清单资源、`provides` 与包内文件三方自洽），只是身份由调用方给出。
  * 给了 `db` 就复用调用方的连接（升级持有写事务时必须如此，仓库的连接池上限可能只有 1）。
  */
 async readTemplate(owner:string,input:{contentId:string;contentHash:string;itemLocalId:string;itemVersion:string},db?:PoolClient):Promise<IndustryRoleTemplate>{
  const actor={ownerId:owner,kind:'human'} as const
  const content=db?await this.market.getInTransaction(db,actor,{contentId:input.contentId}):await this.market.get(actor,{contentId:input.contentId});if(content.kind!=='industry-template'||content.hash!==input.contentHash)throw unavailable('员工固定内容与加载记录不一致。')
  const manifest=validateManifest(content.metadata),resource=manifest.resources.find(row=>row.id===input.itemLocalId);if(!resource||resource.kind!=='role'||resource.version!==input.itemVersion||resource.source.kind!=='local')throw unavailable('员工定义与加载记录不一致。')
  const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',path=root+resource.source.path,provided=content.provides.find(row=>row.resourceId===input.itemLocalId),file=content.files.find(row=>row.path===path)
  if(!provided||provided.kind!=='role'||provided.version!==input.itemVersion||provided.path!==path||!file||file.bytes.byteLength>128*1024)throw unavailable('员工固定文件不存在、过大或身份不一致。')
  let raw:string;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes)}catch{throw unavailable('员工定义不是有效 UTF-8。')}
  let value:unknown;try{value=JSON.parse(raw)}catch{throw unavailable('员工定义不是有效 JSON。')}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['format','name','kind','duty','dataScope','executionScope','responsibility','runtimeConfig'].includes(key))||(value as Record<string,unknown>).format!=='teloa.role/v1')throw unavailable('员工定义格式或字段不正确。')
  // 终审 I-2：方案包（含 GitHub 导入）不得指定岗位首选/备用模型；只保留 agentPresetId，模型由本人在岗位设置中选择（方案包 v3 来源留三期）。
  const rawRuntime=(value as Record<string,unknown>).runtimeConfig
  const ignoredModelSelection=!!rawRuntime&&typeof rawRuntime==='object'&&!Array.isArray(rawRuntime)&&('model' in rawRuntime||'fallbackModel' in rawRuntime)
  const runtimeConfig=ignoredModelSelection?(()=>{const {model:_model,fallbackModel:_fallback,...rest}=rawRuntime as Record<string,unknown>;return Object.keys(rest).length?rest:undefined})():rawRuntime
  let full:RoleDefinition;try{const row=value as Record<string,unknown>;full=roleDefinition({name:row.name,kind:row.kind,scopes:['placeholder'],duty:row.duty,dataScope:row.dataScope,executionScope:row.executionScope,skills:[],knowledge:[],responsibility:row.responsibility??emptyResponsibility,...(runtimeConfig===undefined?{}:{runtimeConfig})})}catch{throw unavailable('员工定义字段不合法。')}
  return {fileHash:createHash('sha256').update(file.bytes).digest('hex'),definition:{name:full.name,kind:full.kind,duty:full.duty,dataScope:full.dataScope,executionScope:full.executionScope,...(full.responsibility?{responsibility:full.responsibility}:{}),...(full.runtimeConfig?{runtimeConfig:full.runtimeConfig}:{})},ignoredModelSelection}
 }
}
