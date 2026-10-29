import {WorkError} from '@teloa/contract'
import {createSkillInstallApi,type SkillInstallationRecord} from './skill-install-api.js'
import {recoveryStorageError,type RecoveryJournal} from './recovery-error.js'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type SkillSelection={ownerId:string;nativeName:string;installationId:string;version:number;updatedAt:string}
type Usage={loadId:string;itemInstanceId:string}
type ImpactSide={installationId:string;installationVersion:number;bundleHash:string;availability:'enabled'|'disabled';availabilityVersion:number}
export type SkillSelectionImpact={nativeName:string;selection:{installationId:string;version:number};current:ImpactSide;target:ImpactSide;industryUsages:Usage[]}
export type SkillSelectionPreview={selection:SkillSelection;current:SkillInstallationRecord;target:SkillInstallationRecord;impact:SkillSelectionImpact;impactDigest:string}
export type SkillSelectionCommand={requestId:string;nativeName:string;currentInstallationId:string;targetInstallationId:string;expectedSelectionVersion:number;expectedCurrentBundleHash:string;expectedTargetBundleHash:string;expectedImpactDigest:string;industryUsages:[]}
export type SkillSelectionPending={ownerId:string;targetRecordHash:string;command:SkillSelectionCommand}
export type SkillSelectionChange={receipt:{requestId:string;nativeName:string;before:SkillSelection;result:SkillSelection;migratedIndustryUsages:[];impact:SkillSelectionImpact;impactDigest:string;createdAt:string};current:SkillSelection}

const invalid=()=>new WorkError('teloa/invalid-host-response','技能默认选择回包身份或影响摘要不一致。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const name=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
const owner=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const stamp=(value:unknown):value is string=>{try{return typeof value==='string'&&new Date(value).toISOString()===value}catch{return false}}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!object(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw invalid();return value}
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const digest=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value)))),byte=>byte.toString(16).padStart(2,'0')).join('')
const same=(a:unknown,b:unknown)=>stable(a)===stable(b)

function readSelection(value:unknown,expectedOwner:string,nativeName:string):SkillSelection{
 const row=exact(value,['ownerId','nativeName','installationId','version','updatedAt'])
 if(row.ownerId!==expectedOwner||row.nativeName!==nativeName||!uuid(row.installationId)||!positive(row.version)||!stamp(row.updatedAt))throw invalid()
 return {ownerId:expectedOwner,nativeName,installationId:row.installationId.toLowerCase(),version:row.version,updatedAt:row.updatedAt}
}
function readSide(value:unknown):ImpactSide{
 const row=exact(value,['installationId','installationVersion','bundleHash','availability','availabilityVersion'])
 if(!uuid(row.installationId)||!positive(row.installationVersion)||!hash(row.bundleHash)||row.availability!=='enabled'&&row.availability!=='disabled'||!positive(row.availabilityVersion))throw invalid()
 return {installationId:row.installationId.toLowerCase(),installationVersion:row.installationVersion,bundleHash:row.bundleHash,availability:row.availability,availabilityVersion:row.availabilityVersion}
}
function readImpact(value:unknown):SkillSelectionImpact{
 const row=exact(value,['nativeName','selection','current','target','industryUsages']),selection=exact(row.selection,['installationId','version'])
 if(!name(row.nativeName)||!uuid(selection.installationId)||!positive(selection.version)||!Array.isArray(row.industryUsages)||row.industryUsages.length>1000)throw invalid()
 const industryUsages=row.industryUsages.map(value=>{const item=exact(value,['loadId','itemInstanceId']);if(!uuid(item.loadId)||!uuid(item.itemInstanceId))throw invalid();return {loadId:item.loadId.toLowerCase(),itemInstanceId:item.itemInstanceId.toLowerCase()}})
 if(new Set(industryUsages.map(item=>item.loadId+':'+item.itemInstanceId)).size!==industryUsages.length||industryUsages.some((item,index)=>index>0&&(industryUsages[index-1]!.loadId+':'+industryUsages[index-1]!.itemInstanceId)>=(item.loadId+':'+item.itemInstanceId)))throw invalid()
 return {nativeName:row.nativeName,selection:{installationId:selection.installationId.toLowerCase(),version:selection.version},current:readSide(row.current),target:readSide(row.target),industryUsages}
}
async function readInstallation(value:unknown):Promise<SkillInstallationRecord>{
 if(!object(value)||!uuid(value.id))throw invalid()
 return createSkillInstallApi(async()=>value).get(value.id)
}
async function readPreview(value:unknown,expected:SkillInstallationRecord):Promise<SkillSelectionPreview>{
 const row=exact(value,['selection','current','target','impact','impactDigest'])
 const [current,target]=await Promise.all([readInstallation(row.current),readInstallation(row.target)])
 if(current.ownerId!==expected.ownerId||target.ownerId!==expected.ownerId||current.native.name!==expected.native.name||target.native.name!==expected.native.name||current.state!=='installed'||target.state!=='installed'||current.id===target.id||!same(target,expected))throw invalid()
 const selection=readSelection(row.selection,expected.ownerId,expected.native.name),impact=readImpact(row.impact)
 if(selection.installationId!==current.id||impact.nativeName!==selection.nativeName||!same(impact.selection,{installationId:selection.installationId,version:selection.version})||impact.current.installationId!==current.id||impact.current.installationVersion!==current.version||impact.current.bundleHash!==current.bundleHash||impact.target.installationId!==target.id||impact.target.installationVersion!==target.version||impact.target.bundleHash!==target.bundleHash||!hash(row.impactDigest)||await digest(impact)!==row.impactDigest)throw invalid()
 return {selection,current,target,impact,impactDigest:row.impactDigest}
}
function readCommand(value:unknown):SkillSelectionCommand{
 const row=exact(value,['requestId','nativeName','currentInstallationId','targetInstallationId','expectedSelectionVersion','expectedCurrentBundleHash','expectedTargetBundleHash','expectedImpactDigest','industryUsages'])
 if(!uuid(row.requestId)||!name(row.nativeName)||!uuid(row.currentInstallationId)||!uuid(row.targetInstallationId)||row.currentInstallationId.toLowerCase()===row.targetInstallationId.toLowerCase()||!positive(row.expectedSelectionVersion)||!hash(row.expectedCurrentBundleHash)||!hash(row.expectedTargetBundleHash)||!hash(row.expectedImpactDigest)||!Array.isArray(row.industryUsages)||row.industryUsages.length!==0)throw invalid()
 return {requestId:row.requestId.toLowerCase(),nativeName:row.nativeName,currentInstallationId:row.currentInstallationId.toLowerCase(),targetInstallationId:row.targetInstallationId.toLowerCase(),expectedSelectionVersion:row.expectedSelectionVersion,expectedCurrentBundleHash:row.expectedCurrentBundleHash,expectedTargetBundleHash:row.expectedTargetBundleHash,expectedImpactDigest:row.expectedImpactDigest,industryUsages:[]}
}
function readPending(raw:string):SkillSelectionPending{
 if(raw.length>20000)throw invalid()
 const row=exact(JSON.parse(raw),['schema','ownerId','targetRecordHash','command'])
 if(row.schema!=='teloa.skill-selection-change/v1'||!owner(row.ownerId)||!hash(row.targetRecordHash))throw invalid()
 return {ownerId:row.ownerId,targetRecordHash:row.targetRecordHash,command:readCommand(row.command)}
}
async function readChange(value:unknown,pending:SkillSelectionPending):Promise<SkillSelectionChange>{
 const row=exact(value,['receipt','current']),receipt=exact(row.receipt,['requestId','nativeName','before','result','migratedIndustryUsages','impact','impactDigest','createdAt']),command=pending.command
 const before=readSelection(receipt.before,pending.ownerId,command.nativeName),result=readSelection(receipt.result,pending.ownerId,command.nativeName),current=readSelection(row.current,pending.ownerId,command.nativeName),impact=readImpact(receipt.impact)
 if(receipt.requestId!==command.requestId||receipt.nativeName!==command.nativeName||before.installationId!==command.currentInstallationId||before.version!==command.expectedSelectionVersion||result.installationId!==command.targetInstallationId||result.version!==before.version+1||!stamp(receipt.createdAt)||receipt.createdAt<before.updatedAt||result.updatedAt!==receipt.createdAt||!Array.isArray(receipt.migratedIndustryUsages)||receipt.migratedIndustryUsages.length!==0||receipt.impactDigest!==command.expectedImpactDigest||await digest(impact)!==command.expectedImpactDigest||impact.nativeName!==command.nativeName||!same(impact.selection,{installationId:before.installationId,version:before.version})||impact.current.installationId!==before.installationId||impact.current.bundleHash!==command.expectedCurrentBundleHash||impact.target.installationId!==result.installationId||impact.target.bundleHash!==command.expectedTargetBundleHash||current.version<result.version||current.updatedAt<result.updatedAt||current.version===result.version&&!same(current,result))throw invalid()
 return {receipt:{requestId:command.requestId,nativeName:command.nativeName,before,result,migratedIndustryUsages:[],impact,impactDigest:command.expectedImpactDigest,createdAt:receipt.createdAt},current}
}

export interface SkillSelectionApi{
 get(record:SkillInstallationRecord):Promise<SkillSelection>
 preview(record:SkillInstallationRecord):Promise<SkillSelectionPreview>
 change(preview:SkillSelectionPreview,record:SkillInstallationRecord):Promise<SkillSelectionChange>
 recover(record:SkillInstallationRecord):Promise<SkillSelectionChange>
 pending():SkillSelectionPending|undefined
 recoveryMessage():WorkError|undefined
 discard(record?:SkillInstallationRecord):boolean
}
/** 只切换本人同名技能的默认安装；不安装、迁移行业引用、撤销历史或代为确认。 */
export function createSkillSelectionApi(call:Call,journal?:RecoveryJournal):SkillSelectionApi{
 let pending:SkillSelectionPending|undefined,recoveryError:WorkError|undefined,busy=false
 try{const raw=journal?.read();if(raw!==null&&raw!==undefined)pending=readPending(raw)}catch{recoveryError=recoveryStorageError()}
 const persist=()=>{
  if(!pending)throw invalid()
  try{
   const current=journal?.read()
   if(current!==null&&current!==undefined&&!same(readPending(current),pending))throw Error('Different pending request')
   const text=JSON.stringify({schema:'teloa.skill-selection-change/v1',...pending});journal?.write(text)
   if(journal&&journal.read()!==text)throw Error('Journal verification failed')
  }catch{throw new WorkError('teloa/recovery-write-failed','技能选择原请求未能可靠保存，尚未发送。')}
 }
 const clear=(expected?:SkillSelectionPending)=>{try{const current=journal?.read();if(expected&&current!==null&&current!==undefined&&!same(readPending(current),expected))throw Error('Different pending request');journal?.clear();if(journal&&journal.read()!==null)throw Error('Journal not cleared')}catch{throw new WorkError('teloa/recovery-clear-failed','技能选择原请求恢复记录未能清除。')}}
 const send=async():Promise<SkillSelectionChange>=>{
  if(recoveryError)throw recoveryError
  if(!pending)throw new WorkError('teloa/invalid-input','没有待核对的技能默认选择请求。')
  if(busy)throw new WorkError('teloa/conflict','技能默认选择正在核对。')
  busy=true
  try{persist();const fixed=pending,result=await readChange(await call('skill-selections/change',fixed.command),fixed);clear(fixed);pending=undefined;return result}finally{busy=false}
 }
 return {
  async get(record:SkillInstallationRecord){const target=await readInstallation(record);return readSelection(await call('skill-selections/get',{nativeName:target.native.name}),target.ownerId,target.native.name)},
  async preview(record:SkillInstallationRecord){
   if(recoveryError)throw recoveryError
   if(pending)throw new WorkError('teloa/conflict','请先核对原技能默认选择请求。')
   const target=await readInstallation(record),selection=readSelection(await call('skill-selections/get',{nativeName:target.native.name}),target.ownerId,target.native.name)
   if(selection.installationId===target.id)throw new WorkError('teloa/conflict','此安装已是当前默认选择。')
   const result=await readPreview(await call('skill-selections/preview',{currentInstallationId:selection.installationId,targetInstallationId:target.id}),target)
   if(!same(result.selection,selection))throw invalid()
   return result
  },
  async change(value:SkillSelectionPreview,record:SkillInstallationRecord){
   if(recoveryError)throw recoveryError
   if(pending)throw new WorkError('teloa/conflict','请先核对原技能默认选择请求。')
   const target=await readInstallation(record),preview=await readPreview(value,target)
   if(preview.impact.target.availability!=='enabled')throw new WorkError('teloa/conflict','目标安装已停用，请先恢复后再切换。')
   const targetRecordHash=await digest(target)
   if(pending||busy)throw new WorkError('teloa/conflict','请先核对原技能默认选择请求。')
   pending={ownerId:preview.selection.ownerId,targetRecordHash,command:{requestId:crypto.randomUUID(),nativeName:preview.selection.nativeName,currentInstallationId:preview.current.id,targetInstallationId:preview.target.id,expectedSelectionVersion:preview.selection.version,expectedCurrentBundleHash:preview.current.bundleHash,expectedTargetBundleHash:preview.target.bundleHash,expectedImpactDigest:preview.impactDigest,industryUsages:[]}}
   return send()
  },
  async recover(record:SkillInstallationRecord){
   if(recoveryError)throw recoveryError
   const original=pending,target=await readInstallation(record)
   if(!original||target.ownerId!==original.ownerId||target.native.name!==original.command.nativeName||target.id!==original.command.targetInstallationId||target.bundleHash!==original.command.expectedTargetBundleHash||await digest(target)!==original.targetRecordHash||pending!==original)throw new WorkError('teloa/conflict','待核对的技能默认选择已变化，请返回原目标处理。')
   return send()
  },
  pending:()=>pending?structuredClone(pending):undefined,
  recoveryMessage:()=>recoveryError,
  discard(record?:SkillInstallationRecord){if(busy)throw new WorkError('teloa/conflict','技能默认选择正在核对。');if(pending&&record&&(pending.ownerId!==record.ownerId||pending.command.nativeName!==record.native.name||pending.command.targetInstallationId!==record.id))throw new WorkError('teloa/conflict','待核对的技能默认选择已变化，请返回原目标处理。');const had=!!pending||!!recoveryError;clear(pending);pending=undefined;recoveryError=undefined;return had},
 }
}
