import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {WorkError,businessCustomizationLimits,businessDefinitionKinds,businessDefinitionCanonicalBody,readBusinessDefinitionBody,readBusinessObjectTypeDefinitionV2,readBusinessViewDefinitionVersioned,businessConfigurationDefinitionKinds,businessConfigurationFormat,businessConfigurationFormatV2,type BusinessDefinitionKind,type BusinessLocalDefinitionVersion} from '@teloa/contract'
export const businessLocalDefinitionSchema='teloa.business-local-definition/v1'
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const localIdText=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const corrupt=(message:string)=>new WorkError('teloa/storage-corrupt',message)
function kindOf(value:unknown):BusinessDefinitionKind{
 if(typeof value!=='string'||!businessDefinitionKinds.includes(value as BusinessDefinitionKind))throw corrupt('业务定义种类损坏，已停止读取。')
 return value as BusinessDefinitionKind
}
/** 旧摘要域和字节公式保持不变；回退到相同正文仍得到相同身份。 */
export const businessLocalDefinitionHash=(scope:string,kind:BusinessDefinitionKind,localId:string,semver:string,bodyHash:string):string=>
 sha256(JSON.stringify([businessLocalDefinitionSchema,scope,kind,localId,semver,bodyHash]))
/** 版本行连带它的种类、标识与正文：目录只要前六列，台账合并还要正文。 */
type StoredVersion=BusinessLocalDefinitionVersion&{kind:BusinessDefinitionKind;localId:string;body:string}

export function versionOf(scope:string,row:Record<string,unknown>):StoredVersion{
 if(typeof row.local_id!=='string'||!localIdText.test(row.local_id)||typeof row.semver!=='string'||typeof row.body!=='string'||typeof row.definition_hash!=='string'||typeof row.body_hash!=='string'||!uuid(row.draft_id)||!(row.created_at instanceof Date)||!Number.isSafeInteger(Number(row.version))||Number(row.version)<1)throw corrupt('本地业务定义版本记录损坏，已停止读取。')
 const kind=kindOf(row.kind)
 if(row.body_hash!==sha256(row.body)||row.definition_hash!==businessLocalDefinitionHash(scope,kind,row.local_id,row.semver,row.body_hash))throw corrupt('本地业务定义校验值与正文不一致，已停止读取。')
 return {
  kind,localId:row.local_id,version:Number(row.version),semver:row.semver,
  definitionHash:row.definition_hash,bodyHash:row.body_hash,body:row.body,
  createdAt:row.created_at.toISOString(),draftId:row.draft_id,
 }
}


/** 校验和规范化是独立采用与整体采用共用的唯一正文边界。 */
export function prepareBusinessDefinition(scope:string,kind:BusinessDefinitionKind,value:unknown){
 const definition=readBusinessDefinitionBody(kind,value)
 return prepareValidatedDefinition(scope,kind,definition)
}
function prepareValidatedDefinition(scope:string,kind:BusinessDefinitionKind,definition:{domain:string;id:string;version:string}){
 if(definition.domain!==scope)throw new WorkError('teloa/invalid-input','业务定义所属业务范围与目标业务范围不一致。')
 const body=businessDefinitionCanonicalBody(definition),bodyHash=sha256(body)
 return {kind,localId:definition.id,semver:definition.version,body,bodyHash,definitionHash:businessLocalDefinitionHash(scope,kind,definition.id,definition.version,bodyHash)}
}
/** 仅整体配置可选 v2；旧独立定义入口继续只读取 v1。 */
export function prepareBusinessConfigurationDefinition(scope:string,kind:BusinessDefinitionKind,value:unknown,format:string){
 if(format===businessConfigurationFormat)return prepareBusinessDefinition(scope,kind,value)
 if(format!==businessConfigurationFormatV2||!businessConfigurationDefinitionKinds.includes(kind as typeof businessConfigurationDefinitionKinds[number]))throw new WorkError('teloa/invalid-input','业务配置定义格式版本不支持。')
 return kind==='object-type'?prepareValidatedDefinition(scope,kind,readBusinessObjectTypeDefinitionV2(value)):kind==='view'?prepareValidatedDefinition(scope,kind,readBusinessViewDefinitionVersioned(value)):prepareBusinessDefinition(scope,kind,value)
}
/** 调用方持有配置锁并负责事务；不涉及独立草案配额或预览凭证。 */
export async function insertBusinessDefinitionVersion(db:PoolClient,input:{ownerId:string;scope:string;kind:BusinessDefinitionKind;definition:unknown;draftId:string;now:string;configurationFormat?:string}){
 const prepared=input.configurationFormat===undefined?prepareBusinessDefinition(input.scope,input.kind,input.definition):prepareBusinessConfigurationDefinition(input.scope,input.kind,input.definition,input.configurationFormat)
 const chain=(await db.query('select version from teloa_business_local_definitions where owner_id=$1 and scope_id=$2 and kind=$3 and local_id=$4 order by version',[input.ownerId,input.scope,input.kind,prepared.localId])).rows as Array<{version:number}>
 if(chain.length>=businessCustomizationLimits.versionsPerDefinition)throw new WorkError('teloa/conflict','本地业务定义 '+input.kind+':'+prepared.localId+' 的版本链已达 '+businessCustomizationLimits.versionsPerDefinition+' 条，不予截断也不覆盖最旧的一条。')
 const version=(chain.length?Number(chain[chain.length-1]!.version):0)+1
 await db.query(`insert into teloa_business_local_definitions(owner_id,scope_id,kind,local_id,version,semver,definition_hash,body_hash,body,draft_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
 [input.ownerId,input.scope,input.kind,prepared.localId,version,prepared.semver,prepared.definitionHash,prepared.bodyHash,prepared.body,input.draftId,input.now])
 return {...prepared,version}
}
