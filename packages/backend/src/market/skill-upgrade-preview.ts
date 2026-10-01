import {createHash} from 'node:crypto'
import {WorkError,isRecord} from '@teloa/contract'
import type {SkillAvailabilityPreview,SkillAvailabilityService} from './skill-availability.ts'
import type {NativeSkillMetadata,SkillInstallationFilesPort,SkillInstallPreview} from './skill-installations.ts'
import type {SkillInstallSourceBundle,SkillInstallSourceIdentity,SkillInstallSourceInput} from './skill-install-source.ts'
import {marketTrustHash,normalizeMarketSourceTrust} from './content-store.ts'

export type SkillUpgradeFileChange={
 path:string
 change:'added'|'removed'|'modified'|'unchanged'
 before:{hash:string;size:number}|null
 after:{hash:string;size:number}|null
}
export type SkillUpgradePreviewInput={installationId:string;target:SkillInstallSourceInput}
export type SkillUpgradePreview={
 current:SkillAvailabilityPreview
 target:SkillInstallPreview
 files:SkillUpgradeFileChange[]
 sameResourceId:boolean
 blockers:Array<'installation-not-installed'|'same-source'|'native-name-mismatch'>
}

type AvailabilityPort=Pick<SkillAvailabilityService,'preview'>
type SourceReader={read:(ownerId:string,input:SkillInstallSourceInput)=>Promise<SkillInstallSourceBundle>}

const MAX_FILE=2*1024*1024,MAX_TOTAL=20*1024*1024
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const order=(a:string,b:string)=>a<b?-1:a>b?1:0
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>isRecord(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>order(a,b))):item)
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const invalid=()=>new WorkError('teloa/invalid-input','技能升级预览请求格式不正确。')
const unavailable=()=>new WorkError('teloa/source-unavailable','技能升级固定来源或摘要已变化。')
const exact=(value:unknown,keys:readonly string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}

function readInput(value:unknown):SkillUpgradePreviewInput{
 const row=exact(value,['installationId','target'])
 if(!uuid(row.installationId))throw invalid()
 const target=exact(row.target,['kind','contentId','loadId','itemInstanceId'])
 if(target.kind==='atomic'){
  exact(target,['kind','contentId']);if(!uuid(target.contentId))throw invalid()
  return {installationId:row.installationId.toLowerCase(),target:{kind:'atomic',contentId:target.contentId.toLowerCase()}}
 }
 exact(target,['kind','loadId','itemInstanceId'])
 if(target.kind!=='industry'||!uuid(target.loadId)||!uuid(target.itemInstanceId))throw invalid()
 return {installationId:row.installationId.toLowerCase(),target:{kind:'industry',loadId:target.loadId.toLowerCase(),itemInstanceId:target.itemInstanceId.toLowerCase()}}
}

function readSource(value:unknown):SkillInstallSourceIdentity{
 try{
  if(!isRecord(value))throw Error()
  const common=()=>{if(!uuid(value.contentId)||!hex(value.contentHash)||!text(value.resourceId,120)||!text(value.resourceVersion,80))throw Error()}
  if(value.kind==='atomic'){
   if(Object.keys(value).some(key=>!['kind','contentId','contentHash','resourceId','resourceVersion'].includes(key)))throw Error()
   common();return value as unknown as SkillInstallSourceIdentity
  }
  if(value.kind==='industry-local'){
   if(Object.keys(value).some(key=>!['kind','loadId','itemInstanceId','contentId','contentHash','resourceId','resourceVersion'].includes(key)))throw Error()
   common();if(!uuid(value.loadId)||!uuid(value.itemInstanceId))throw Error();return value as unknown as SkillInstallSourceIdentity
  }
  if(value.kind==='industry-public'){
   if(Object.keys(value).some(key=>!['kind','loadId','itemInstanceId','contentId','contentHash','sourceContentId','sourceContentHash','sourceResourceId','sourceResourceVersion','resourceId','resourceVersion'].includes(key)))throw Error()
   common();if(!uuid(value.loadId)||!uuid(value.itemInstanceId)||!uuid(value.sourceContentId)||!hex(value.sourceContentHash)||!text(value.sourceResourceId,120)||!text(value.sourceResourceVersion,80))throw Error();return value as unknown as SkillInstallSourceIdentity
  }
  throw Error()
 }catch{throw unavailable()}
}

function sourceInput(source:SkillInstallSourceIdentity):SkillInstallSourceInput{
 return source.kind==='atomic'?{kind:'atomic',contentId:source.contentId}:{kind:'industry',loadId:source.loadId,itemInstanceId:source.itemInstanceId}
}
function sourceKey(source:SkillInstallSourceIdentity){return stable(source.kind==='atomic'?['atomic',source.contentId,source.contentHash,source.resourceId,source.resourceVersion]:source.kind==='industry-public'?['atomic',source.sourceContentId,source.sourceContentHash,source.sourceResourceId,source.sourceResourceVersion]:['industry-local',source.contentId,source.contentHash,source.resourceId,source.resourceVersion])}
function resourceId(source:SkillInstallSourceIdentity){return source.kind==='industry-public'?source.sourceResourceId:source.resourceId}
function matchesInput(input:SkillInstallSourceInput,source:SkillInstallSourceIdentity){
 return input.kind==='atomic'?source.kind==='atomic'&&source.contentId.toLowerCase()===input.contentId:source.kind!=='atomic'&&source.loadId.toLowerCase()===input.loadId&&source.itemInstanceId.toLowerCase()===input.itemInstanceId
}

function readBundle(value:SkillInstallSourceBundle,ownerId:string):{bundle:SkillInstallSourceBundle;files:{path:string;hash:string;size:number}[]}{
 if(!isRecord(value)||value.ownerId!==ownerId||value.entryPath!=='SKILL.md'||!hex(value.bundleHash)||!Array.isArray(value.files)||value.files.length<1||value.files.length>500)throw unavailable()
 const source=readSource(value.source),names=new Set<string>(),portableNames=new Set<string>();let total=0,previous:string|undefined
 const normalized=value.files.map(item=>{
  if(!isRecord(item)||Object.keys(item).some(key=>!['path','hash','bytes'].includes(key))||typeof item.path!=='string'||item.path.length>500||item.path!==item.path.trim()||item.path.startsWith('/')||/[\\:?%#\u0000-\u001f\u007f]/.test(item.path)||item.path.split('/').some(part=>!part||part==='.'||part==='..')||!hex(item.hash)||!(item.bytes instanceof Uint8Array)||item.bytes.byteLength>MAX_FILE||sha(item.bytes)!==item.hash)throw unavailable()
  if(previous!==undefined&&order(previous,item.path)>=0)throw unavailable();previous=item.path
  const portable=item.path.normalize('NFC').toLowerCase();if(portableNames.has(portable))throw unavailable();portableNames.add(portable);names.add(item.path)
  total+=item.bytes.byteLength;if(total>MAX_TOTAL)throw unavailable()
  return {path:item.path,hash:item.hash,size:item.bytes.byteLength}
 })
 if(!names.has('SKILL.md')||normalized.filter(file=>file.path.split('/').at(-1)==='SKILL.md').length!==1||sha(JSON.stringify(normalized.map(file=>[file.path,file.hash])))!==value.bundleHash)throw unavailable()
 for(const name of portableNames){const parts=name.split('/');while(parts.length>1){parts.pop();if(portableNames.has(parts.join('/')))throw unavailable()}}
 let fixedTrust:Pick<SkillInstallSourceBundle,'trust'|'trustHash'>={};if(value.trust!==undefined||value.trustHash!==undefined){if(value.trust===undefined||!hex(value.trustHash))throw unavailable();let trust;try{trust=normalizeMarketSourceTrust(value.trust)}catch{throw unavailable()}if(marketTrustHash(trust)!==value.trustHash)throw unavailable();fixedTrust={trust,trustHash:value.trustHash}}
 return {bundle:{ownerId,source,entryPath:'SKILL.md',files:value.files.map(file=>({path:file.path,hash:file.hash,bytes:Uint8Array.from(file.bytes)})),bundleHash:value.bundleHash,...fixedTrust},files:normalized}
}

function readNative(value:unknown):NativeSkillMetadata{
 if(!isRecord(value)||Object.keys(value).some(key=>!['name','description','modelInvocable','userInvocable','bodyHash'].includes(key))||typeof value.name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)||typeof value.description!=='string'||!value.description||typeof value.modelInvocable!=='boolean'||typeof value.userInvocable!=='boolean'||!hex(value.bodyHash))throw unavailable()
 return {name:value.name,description:value.description,modelInvocable:value.modelInvocable,userInvocable:value.userInvocable,bodyHash:value.bodyHash}
}

function diff(before:{path:string;hash:string;size:number}[],after:{path:string;hash:string;size:number}[]):SkillUpgradeFileChange[]{
 const old=new Map(before.map(file=>[file.path,file])),next=new Map(after.map(file=>[file.path,file]))
 return [...new Set([...old.keys(),...next.keys()])].sort(order).map(path=>{const left=old.get(path),right=next.get(path),beforeFile=left?{hash:left.hash,size:left.size}:null,afterFile=right?{hash:right.hash,size:right.size}:null;return {path,change:left===undefined?'added':right===undefined?'removed':left.hash===right.hash&&left.size===right.size?'unchanged':'modified',before:beforeFile,after:afterFile}})
}

export class SkillUpgradePreviewService{
 private readonly availability:AvailabilityPort
 private readonly sourceReader:SourceReader
 private readonly files:Pick<SkillInstallationFilesPort,'inspect'|'verify'>
 constructor(availability:AvailabilityPort,sourceReader:SourceReader,files:Pick<SkillInstallationFilesPort,'inspect'|'verify'>){this.availability=availability;this.sourceReader=sourceReader;this.files=files}
 async preview(ownerId:string,value:unknown):Promise<SkillUpgradePreview>{
  if(!text(ownerId,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const input=readInput(value),current=await this.availability.preview(ownerId,{installationId:input.installationId})
  if(current.installation.id!==input.installationId||current.installation.ownerId!==ownerId||current.availability.installationId!==input.installationId||current.availability.ownerId!==ownerId)throw new WorkError('teloa/storage-corrupt','技能升级当前安装快照损坏，已停止读取。')
  const before=readBundle(await this.sourceReader.read(ownerId,sourceInput(current.installation.source)),ownerId)
  if(stable(before.bundle.source)!==stable(current.installation.source)||before.bundle.bundleHash!==current.installation.bundleHash)throw unavailable()
  if(current.installation.state==='installed')await this.files.verify(current.installation.id,before.bundle,current.installation.native)
  const after=readBundle(await this.sourceReader.read(ownerId,input.target),ownerId)
  if(!matchesInput(input.target,after.bundle.source))throw unavailable()
  const metadata=readNative(await this.files.inspect(after.bundle))
  const blockers:SkillUpgradePreview['blockers']=[]
  if(current.installation.state!=='installed')blockers.push('installation-not-installed')
  if(sourceKey(before.bundle.source)===sourceKey(after.bundle.source))blockers.push('same-source')
  if(current.installation.native.name!==metadata.name)blockers.push('native-name-mismatch')
  return {current,target:{source:after.bundle.source,bundleHash:after.bundle.bundleHash,native:metadata,files:after.files,...(after.bundle.trust&&after.bundle.trustHash?{trust:after.bundle.trust,trustHash:after.bundle.trustHash,installationPlan:{skills:[{id:after.bundle.source.resourceId,version:after.bundle.source.resourceVersion,path:'SKILL.md'}],plugins:after.bundle.trust.plugins,connections:after.bundle.trust.externalCapabilities,permissions:after.bundle.trust.permissions}}:{})},files:diff(before.files,after.files),sameResourceId:resourceId(before.bundle.source)===resourceId(after.bundle.source),blockers}
 }
}
