import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {readIndustryDirectory} from '../src/client/industry-directory.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {MarketItem,MarketTrust} from '../src/client/market-preview.ts'
import type {SkillInstallationRecord,SkillInstallPreview} from '../src/client/skill-install-api.ts'
import {resolveTemplateShareSkills} from '../src/client/template-share-skill-sources.ts'
import {buildSharePlan} from '../src/client/share-package-plan.ts'
import {readAtomicSkill} from '../src/client/atomic-skill.ts'
import {shareIndustryItem} from '../src/client/template-share-accept.ts'
import {readSharePackage} from '../src/client/share-package-plan.ts'

const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const text='---\nname: meeting-summary\ndescription: Summarize supplied notes.\n---\nUse only the supplied notes.\n'
const trust:MarketTrust={publisher:'Original publisher',repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'undeclared',dsh:'undeclared'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'Local file'}}
async function fixture(){
 const manifest={format:'teloa.business-package/v2',id:'meeting-app',title:'Meeting app',description:'Summarize notes.',version:'1.0.0',domain:'general',scope:'general',resources:[{id:'summary',kind:'skill',title:'Summary',version:'1.0.0',required:true,source:{kind:'local',path:'summary/SKILL.md'}}],relations:[],entrypoints:[]}
 const files=[{path:'bundle/teloa.json',text:JSON.stringify(manifest)},{path:'bundle/summary/SKILL.md',text}]
 const item=await readIndustryDirectory(files.map(file=>{const bytes=new TextEncoder().encode(file.text);return {path:file.path,size:bytes.length,read:async()=>bytes}}),'bundle/teloa.json','Meeting app')
 item.contentStorage={contentId:id(1),createdAt:'2026-10-16T00:00:00.000Z',loaded:true};item.trust=structuredClone(trust)
 const source={kind:'industry-local' as const,loadId:id(2),itemInstanceId:id(3),contentId:id(1),contentHash:item.packageContent!.hash,resourceId:'summary',resourceVersion:'1.0.0'}
 const native={name:'meeting-summary',description:'Summarize supplied notes.',modelInvocable:true,userInvocable:true,bodyHash:'a'.repeat(64)},bundleHash=hash(JSON.stringify([['SKILL.md',hash(text)]]))
 const installed:SkillInstallationRecord={id:id(4),ownerId:'self',source,bundleHash,native,trust:structuredClone(trust),trustHash:'b'.repeat(64),state:'installed',version:2,createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:01.000Z'}
 const load={id:id(2),ownerId:'self',contentId:id(1),contentHash:source.contentHash,templateId:manifest.id,templateVersion:manifest.version,items:[{localId:'summary',instanceId:id(3),kind:'skill',version:'1.0.0',status:'pending-adapter'}],status:'active'} as IndustryLoadRecord
 const preview:SkillInstallPreview={source:structuredClone(source),bundleHash,native:structuredClone(native),files:[{path:'SKILL.md',hash:hash(text),size:new TextEncoder().encode(text).length}],trust:structuredClone(trust),trustHash:installed.trustHash!}
 const ports={skills:{list:async()=>({items:[installed],usages:[]}),preview:async()=>preview},contents:{hydrate:async()=>item as MarketItem},loads:{get:async()=>load}}
 return {ports,item,installed,load,preview}
}

test('an installed industry-local skill shares its original licensed static text instead of an unavailable placeholder',async()=>{
 const {ports}=await fixture()
 const [source]=await resolveTemplateShareSkills(['meeting-summary'],ports)
 assert.equal(source?.text,text)
 assert.equal(source.license,'MIT');assert.equal(source.publisher,'Original publisher')
 assert.equal(source.resourceId,'summary');assert.equal(source.version,'1.0.0')
})

test('sharing the selected installation keeps its fixed source when an older same-name installation has no license',async()=>{
 const current=await fixture(),old=await fixture()
 old.installed.id=id(40);old.load.id=id(20);old.load.contentId=id(10);old.item.contentStorage!.contentId=id(10)
 Object.assign(old.installed.source,{loadId:id(20),contentId:id(10)});old.preview.source=structuredClone(old.installed.source)
 old.item.trust!.license={status:'missing'}
 const ports={skills:{list:async()=>({items:[old.installed,current.installed],usages:[]}),preview:async(source:{kind:string;loadId?:string})=>source.loadId===old.load.id?old.preview:current.preview},contents:{hydrate:async(item:MarketItem)=>item.contentStorage?.contentId===old.load.contentId?old.item:current.item},loads:{get:async(loadId:string)=>loadId===old.load.id?old.load:current.load}}
 const selected={installationId:current.installed.id}
 const [source]=await resolveTemplateShareSkills(['meeting-summary'],ports,selected)
 assert.equal(source?.text,text);assert.equal(source.license,'MIT');assert.equal(source.publisher,'Original publisher')
 await assert.rejects(resolveTemplateShareSkills(['meeting-summary'],ports,{installationId:id(99)}),{code:'teloa/source-unavailable'})
 await assert.rejects(resolveTemplateShareSkills(['different-name'],ports,selected),{code:'teloa/source-unavailable'})
 assert.equal((await resolveTemplateShareSkills(['meeting-summary'],ports,{installationId:old.installed.id}))[0]!.text,undefined,'明确选择无许可的旧来源也不能借用新来源许可')
})

test('a local share refuses mismatched fixed load, content, resource, file or installed preview identities',async t=>{
 const changes:{name:string;change:(f:Awaited<ReturnType<typeof fixture>>)=>void}[]=[
  {name:'load',change:f=>{f.load.id=id(99)}},{name:'owner',change:f=>{f.load.ownerId='other'}},
  {name:'load content',change:f=>{f.load.contentId=id(99)}},{name:'load hash',change:f=>{f.load.contentHash='c'.repeat(64)}},
  {name:'load item',change:f=>{f.load.items[0]!.instanceId=id(99)}},{name:'resource',change:f=>{f.load.items[0]!.localId='different'}},
  {name:'resource version',change:f=>{f.load.items[0]!.version='2.0.0'}},{name:'content',change:f=>{f.item.contentStorage!.contentId=id(99)}},
  {name:'content hash',change:f=>{f.item.packageContent!.hash='c'.repeat(64)}},
  {name:'manifest version',change:f=>{(f.item.manifest as any).resources[0].version='2.0.0'}},
  {name:'file bytes',change:f=>{f.item.packageContent!.files.find(file=>file.path==='bundle/summary/SKILL.md')!.bytes=new TextEncoder().encode('changed')}},
  {name:'preview source',change:f=>{f.preview.source.contentId=id(99)}},
  {name:'preview bundle',change:f=>{f.preview.bundleHash='c'.repeat(64)}},
  {name:'preview native',change:f=>{f.preview.native.name='different'}},
  {name:'preview file',change:f=>{f.preview.files[0]!.hash='c'.repeat(64)}},
 ]
 for(const change of changes)await t.test(change.name,async()=>{const f=await fixture();change.change(f);await assert.rejects(resolveTemplateShareSkills(['meeting-summary'],f.ports),{code:'teloa/source-unavailable'})})
})

test('a missing license remains unshareable',async()=>{
 const f=await fixture();f.item.trust!.license={status:'missing'}
 assert.equal((await resolveTemplateShareSkills(['meeting-summary'],f.ports))[0]!.text,undefined)
})

test('an unreadable installation directory or unknown source cannot be converted into a successful empty share',async()=>{
 const f=await fixture()
 f.ports.skills.list=async()=>{throw Error('Unavailable directory')}
 await assert.rejects(resolveTemplateShareSkills(['meeting-summary'],f.ports),/Unavailable directory/)
 f.ports.skills.list=async()=>({items:[{...f.installed,source:{...f.installed.source,kind:'unknown'}} as unknown as SkillInstallationRecord],usages:[]})
 await assert.rejects(resolveTemplateShareSkills(['meeting-summary'],f.ports),{code:'teloa/source-unavailable'})
})

test('local installed sharing carries supporting static files with their exact bytes and never truncates a method to its entry',async()=>{
 const f=await fixture(),support='\uFEFFOriginal reference\r\nSecond line.\r\n',bytes=new TextEncoder().encode(support)
 f.item.packageContent!.files.push({path:'bundle/summary/references/original.md',hash:hash(support),bytes})
 f.preview.files.push({path:'references/original.md',hash:hash(support),size:bytes.length});f.preview.files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
 f.installed.bundleHash=f.preview.bundleHash=hash(JSON.stringify(f.preview.files.map(file=>[file.path,file.hash])))
 const [source]=await resolveTemplateShareSkills(['meeting-summary'],f.ports)
 const pkg=buildSharePlan({subject:'skill',publisher:'Reviewer',roles:[],skills:[source!]})
 assert.equal(pkg.files.find(file=>file.path==='summary/SKILL.md')?.text,text)
 const actual=pkg.files.find(file=>file.path==='summary/references/original.md')?.text
 assert.equal(actual,support);assert.equal(hash(actual!),hash(support))
})

test('the existing share boundary rejects executable or undeclared JSON supporting files instead of omitting them',async t=>{
 for(const path of ['run.sh','script.py','hidden.exe','../escape.md','notes.json'])await t.test(path,async()=>{
  const f=await fixture(),support='{"note":"Static source"}',bytes=new TextEncoder().encode(support)
  f.item.packageContent!.files.push({path:'bundle/summary/'+path,hash:hash(support),bytes})
  f.preview.files.push({path,hash:hash(support),size:bytes.length});f.preview.files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  f.installed.bundleHash=f.preview.bundleHash=hash(JSON.stringify(f.preview.files.map(file=>[file.path,file.hash])))
  await assert.rejects(async()=>{const [source]=await resolveTemplateShareSkills(['meeting-summary'],f.ports);buildSharePlan({subject:'skill',publisher:'Reviewer',roles:[],skills:[source!]})})
 })
})

test('atomic installed methods use the same complete static-file validation and preserve their original source',async()=>{
 const f=await fixture(),support='A reusable reference.\r\n',bytes=new TextEncoder().encode(support)
 const content=await readAtomicSkill([{path:'atomic/SKILL.md',size:new TextEncoder().encode(text).length,read:async()=>new TextEncoder().encode(text)},{path:'atomic/references/guide.md',size:bytes.length,read:async()=>bytes}],{id:'atomic-summary',title:'Atomic summary',version:'1.0.0',categories:[]})
 f.installed.source={kind:'atomic',contentId:id(1),contentHash:content.hash,resourceId:content.id,resourceVersion:content.version}
 f.preview.source=structuredClone(f.installed.source)
 f.preview.files=content.files.map(file=>({path:file.path.slice('atomic/'.length),hash:file.hash,size:file.bytes.length}))
 f.installed.bundleHash=f.preview.bundleHash=hash(JSON.stringify(f.preview.files.map(file=>[file.path,file.hash])))
 f.ports.contents.hydrate=async()=>({...f.item,kind:'skill',atomicSkill:content})
 f.ports.loads.get=async()=>{throw Error('Atomic source must not read a load')}
 const before=structuredClone({record:f.installed,preview:f.preview,content}),[source]=await resolveTemplateShareSkills(['meeting-summary'],f.ports)
 const pkg=buildSharePlan({subject:'skill',publisher:'Reviewer',roles:[],skills:[source!]})
 assert.equal(pkg.files.find(file=>file.path==='atomic-summary/references/guide.md')?.text,support)
 assert.deepEqual({record:f.installed,preview:f.preview,content},before)
 content.hash='c'.repeat(64)
 await assert.rejects(resolveTemplateShareSkills(['meeting-summary'],f.ports),{code:'teloa/source-unavailable'})
})

test('public references stay pinned and an uninstalled method remains an explicit configuration requirement',async()=>{
 const f=await fixture()
 f.installed.source={...f.installed.source as Extract<SkillInstallationRecord['source'],{kind:'industry-local'}>,kind:'industry-public',sourceContentId:id(9),sourceContentHash:'d'.repeat(64),sourceResourceId:'official-summary',sourceResourceVersion:'2.3.4'}
 assert.deepEqual(await resolveTemplateShareSkills(['meeting-summary','not-installed'],f.ports),[{name:'meeting-summary',title:'meeting-summary',resourceId:'summary',version:'2.3.4',publicId:'official-summary'},{name:'not-installed'}])
})

test('invalid UTF-8 supporting data and mismatched entry text are refused, not changed or partially shared',async()=>{
 const f=await fixture(),bytes=Uint8Array.from([0xff]),fileHash=createHash('sha256').update(bytes).digest('hex')
 f.item.packageContent!.files.push({path:'bundle/summary/reference.md',hash:fileHash,bytes})
 f.preview.files.push({path:'reference.md',hash:fileHash,size:1})
 f.installed.bundleHash=f.preview.bundleHash=hash(JSON.stringify(f.preview.files.map(file=>[file.path,file.hash])))
 await assert.rejects(resolveTemplateShareSkills(['meeting-summary'],f.ports),{code:'teloa/source-unavailable'})
 assert.throws(()=>buildSharePlan({subject:'skill',publisher:'Reviewer',roles:[],skills:[{name:'summary',text,license:'MIT',files:[{path:'SKILL.md',text:'Changed entry'}]}]}),/entry must match/)
})

test('deselecting a bundled skill removes its supporting files while preserving the selected method and explicit knowledge',async()=>{
 const pkg=buildSharePlan({subject:'employee',publisher:'Reviewer',roles:[{id:'employee',name:'Analyst',kind:'employee',duty:'Read supplied notes.',dataScope:'Supplied notes.',executionScope:'No external writes.',skills:['drop','keep'],knowledge:[]}],skills:[{name:'drop',text,license:'MIT',files:[{path:'SKILL.md',text},{path:'reference.md',text:'Dropped reference'}]},{name:'keep',text,license:'MIT',files:[{path:'SKILL.md',text},{path:'reference.md',text:'Kept reference'}]}]})
 const manifest=JSON.parse(pkg.files.find(file=>file.path==='teloa.json')!.text)
 manifest.resources.push({id:'retained-knowledge',kind:'knowledge',title:'Knowledge',version:'1.0.0',required:true,source:{kind:'local',path:'drop/knowledge.md'}})
 pkg.files.find(file=>file.path==='teloa.json')!.text=JSON.stringify(manifest)
 pkg.files.push({path:'drop/knowledge.md',text:'Explicit retained knowledge'})
 const original=structuredClone(pkg),item=await shareIndustryItem(readSharePackage(pkg) as never,{scope:'general',skills:['keep']})
 const files=item.packageContent!.files
 assert.equal(files.some(file=>file.path==='drop/SKILL.md'||file.path==='drop/reference.md'),false)
 assert.equal(new TextDecoder().decode(files.find(file=>file.path==='keep/reference.md')!.bytes),'Kept reference')
 assert.equal(new TextDecoder().decode(files.find(file=>file.path==='drop/knowledge.md')!.bytes),'Explicit retained knowledge')
 assert.deepEqual(pkg,original)
})

test('the common share parser refuses two resources claiming the same skill entry file',()=>{
 const pkg=buildSharePlan({subject:'skill',publisher:'Reviewer',roles:[],skills:[{name:'summary',text,license:'MIT'}]})
 const manifest=JSON.parse(pkg.files.find(file=>file.path==='teloa.json')!.text)
 manifest.resources.push({id:'knowledge',kind:'knowledge',title:'Knowledge',version:'1.0.0',required:true,source:{kind:'local',path:'summary/SKILL.md'}})
 pkg.files.find(file=>file.path==='teloa.json')!.text=JSON.stringify(manifest)
 assert.throws(()=>readSharePackage(pkg),/missing or reused/)
})
