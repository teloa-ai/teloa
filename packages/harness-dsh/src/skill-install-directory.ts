import {WorkError,isRecord} from '@teloa/contract'

type Handler=(method:string,payload:Record<string,unknown>)=>Promise<unknown>
export type SkillInstallDirectoryPorts={owner:string;marketContentHandler:Handler;industryLoadsHandler:Handler;skillInstallationsHandler:Handler}
type AtomicCandidate={source:{kind:'atomic';contentId:string};title:string;version:string}
type IndustryCandidate={source:{kind:'industry';loadId:string;itemInstanceId:string};title:string;version:string;space:{id:string;name:string}}
export type SkillInstallDirectory={atomic:AtomicCandidate[];industry:IndustryCandidate[];installations:unknown[];usages:unknown[]}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const version=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const bad=()=>new WorkError('teloa/invalid-host-response','技能安装目录返回格式不正确或包含跨本人的记录。')
const object=(value:unknown):Record<string,unknown>=>{if(!isRecord(value))throw bad();return value}
const page=(value:unknown)=>{const row=object(value);if(Object.keys(row).some(key=>!['items','nextCursor'].includes(key))||!Array.isArray(row.items)||(row.nextCursor!==null&&!uuid(row.nextCursor)))throw bad();return row as {items:unknown[];nextCursor:string|null}}

function atomicCandidate(value:unknown,owner:string):AtomicCandidate|null{
 const row=object(value)
 if(row.ownerId!==owner||!uuid(row.id))throw bad()
 if(row.kind!=='atomic-skill')return null
 const metadata=object(row.metadata)
 if(!text(metadata.title,120)||!version(row.version))throw bad()
 return {source:{kind:'atomic',contentId:row.id.toLowerCase()},title:metadata.title,version:row.version}
}

function industryCandidates(value:unknown,owner:string):IndustryCandidate[]{
 const row=object(value),space=object(row.space)
 if(row.ownerId!==owner||!uuid(row.id)||!uuid(space.id)||!text(space.name,80)||!Array.isArray(row.items))throw bad()
 const result:IndustryCandidate[]=[]
 for(const value of row.items){
  const item=object(value)
  if(item.kind!=='skill'||item.status!=='pending-adapter')continue
  if(!uuid(item.instanceId)||!text(item.title,120)||!version(item.version))throw bad()
  result.push({source:{kind:'industry',loadId:row.id.toLowerCase(),itemInstanceId:item.instanceId.toLowerCase()},title:item.title,version:item.version,space:{id:space.id.toLowerCase(),name:space.name}})
 }
 return result
}

/** 仅聚合严格宿主目录摘要；不读取 Skill 文件，也不调用 preview 推断公共来源。 */
export async function readSkillInstallDirectory(ports:SkillInstallDirectoryPorts):Promise<SkillInstallDirectory>{
 if(!text(ports.owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
 const [initial,loadsValue,installationsValue]=await Promise.all([
  ports.marketContentHandler('market-content/list',{limit:100}),
  ports.industryLoadsHandler('industry-loads/list',{}),
  ports.skillInstallationsHandler('skill-installations/list',{}),
 ])
 const atomic:AtomicCandidate[]=[],seenContent=new Set<string>(),seenCursor=new Set<string>()
 let current=page(initial)
 for(;;){
  for(const value of current.items){const candidate=atomicCandidate(value,ports.owner);if(!candidate)continue;const id=candidate.source.contentId;if(seenContent.has(id))throw bad();seenContent.add(id);atomic.push(candidate)}
  if(current.nextCursor===null)break
  const cursor=current.nextCursor.toLowerCase();if(seenCursor.has(cursor))throw bad();seenCursor.add(cursor)
  current=page(await ports.marketContentHandler('market-content/list',{limit:100,cursor}))
 }
 const loads=object(loadsValue),installed=object(installationsValue)
 if(Object.keys(loads).some(key=>key!=='items')||!Array.isArray(loads.items)||Object.keys(installed).some(key=>!['items','usages'].includes(key))||!Array.isArray(installed.items)||!Array.isArray(installed.usages))throw bad()
 const industry=loads.items.flatMap(value=>industryCandidates(value,ports.owner))
 for(const value of installed.items){const row=object(value);if(row.ownerId!==ports.owner)throw bad()}
 return {atomic,industry,installations:installed.items,usages:installed.usages}
}
