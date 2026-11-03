import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readAtomicSkill} from '../src/client/atomic-skill.ts'
import {atomicSkillItem} from '../src/client/atomic-market.ts'
import {buildSkillDerivative,loadSkillDerivative} from '../src/client/skill-derivation.ts'
import type {IndustryModelDependency} from '@teloa/contract'
import type {SkillInstallationRecord} from '../src/client/skill-install-api.ts'

const encode=(value:string)=>new TextEncoder().encode(value),hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
const text='---\nname: evidence-review\ndescription: Review the provided evidence.\n---\nRead [guide](references/guide.md), then check scripts/check.py.\n'
const sourceFiles=[{path:'skill/SKILL.md',bytes:encode(text)},{path:'skill/references/guide.md',bytes:encode('Keep unknown facts separate.\n')},{path:'skill/scripts/check.py',bytes:encode('raise RuntimeError("must not execute")\n')},{path:'skill/assets/sample.bin',bytes:new Uint8Array([0,255,1,128])},{path:'skill/LICENSE',bytes:encode('Original copyright, Apache-2.0.\n')}]
async function fixture(kind:'atomic'|'industry-local'|'industry-public'='atomic',name='evidence-review',models?:IndustryModelDependency[],publicModels?:IndustryModelDependency[]){
 const inputs=sourceFiles.map(file=>file.path.endsWith('/SKILL.md')?{...file,bytes:encode(text.replace('evidence-review',name))}:file)
 const atomic=await readAtomicSkill(inputs.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),{id:name,title:'Evidence review',version:'1.2.0',categories:['review'],...(models?{modelDependencies:models}:{})})
 const files=atomic.files.map(file=>({...file,path:file.path.slice('skill/'.length)})),bundleHash=hash(JSON.stringify(files.map(file=>[file.path,file.hash])))
 const atomicId='11111111-1111-4111-8111-111111111111',industryId='22222222-2222-4222-8222-222222222222',industryHash='a'.repeat(64)
 const source=kind==='atomic'?{kind,contentId:atomicId,contentHash:atomic.hash,resourceId:atomic.id,resourceVersion:atomic.version}:kind==='industry-public'?{kind,loadId:'33333333-3333-4333-8333-333333333333',itemInstanceId:'44444444-4444-4444-8444-444444444444',contentId:industryId,contentHash:industryHash,sourceContentId:atomicId,sourceContentHash:atomic.hash,sourceResourceId:atomic.id,sourceResourceVersion:atomic.version,resourceId:'local-review',resourceVersion:'1.2.0'}:{kind,loadId:'33333333-3333-4333-8333-333333333333',itemInstanceId:'44444444-4444-4444-8444-444444444444',contentId:industryId,contentHash:industryHash,resourceId:'local-review',resourceVersion:'1.2.0'}
 const record={id:'55555555-5555-4555-8555-555555555555',ownerId:'owner',source,bundleHash,native:{name:atomic.id,description:'Review the provided evidence.',modelInvocable:true,userInvocable:true,bodyHash:hash(text)},state:'installed',version:1,createdAt:'2026-10-26T00:00:00Z',updatedAt:'2026-10-26T00:00:00Z'} as SkillInstallationRecord
 const item=kind==='industry-local'?{id:'industry',kind:'bundle',title:'Original team',author:'Original publisher',license:'Apache-2.0',hash:industryHash,contentStorage:{contentId:industryId,createdAt:record.createdAt,loaded:true},manifest:{resources:[{id:'local-review',kind:'skill',version:'1.2.0',title:'Evidence review',...(models?{modelDependencies:models}:{}),source:{kind:'local',path:'skill/SKILL.md'}}]},packageContent:{manifestPath:'teloa.json',hash:industryHash,files:[...atomic.files,{path:'unrelated/private.md',hash:hash('unrelated'),bytes:encode('unrelated')}],resources:[]}}:{...atomicSkillItem(atomic),hash:atomic.hash,author:'Original publisher',license:'Apache-2.0',contentStorage:{contentId:atomicId,createdAt:record.createdAt,loaded:true}}
 const api={get:async()=>record,preview:async()=>({source,bundleHash,native:record.native,files:files.map(file=>({path:file.path,hash:file.hash,size:file.bytes.length}))})}
 const parent={id:'public-parent',kind:'bundle',title:'Original scheme',hash:industryHash,contentStorage:{contentId:industryId,loaded:true},manifest:{resources:[{id:'local-review',kind:'skill',version:'1.2.0',source:{kind:'public',id:atomic.id,version:atomic.version},...(publicModels?{modelDependencies:publicModels}:{})},{id:'unrelated',kind:'skill',version:'1.0.0',source:{kind:'local',path:'other/SKILL.md'},modelDependencies:[{catalogId:'teloa.model.unrelated',version:'1.0.0',usage:'ocr',required:true}]}]},packageContent:{hash:industryHash}}
 const contentApi={list:async()=>kind==='industry-public'?[item,parent]:[item],hydrate:async(summary:any)=>summary.contentStorage?.contentId===industryId&&kind==='industry-public'?parent:item}
 return {record,item,api,contentApi,atomic}
}

for(const kind of ['atomic','industry-local','industry-public'] as const)test('完整读取'+kind+'固定技能，核对全部文件并创建独立名称',async()=>{
 const f=await fixture(kind),before=structuredClone(f.atomic.files),draft=await loadSkillDerivative(f.api,f.contentApi as any,f.record,'12345678-1234-4234-8234-123456789012')
 assert.deepEqual(draft.files.map(file=>file.path),['LICENSE','SKILL.md','assets/sample.bin','references/guide.md','scripts/check.py'])
 assert.match(draft.files.find(file=>file.path==='SKILL.md')!.text!,/name: my-evidence-review-12345678/)
 assert.equal(draft.files.find(file=>file.path==='LICENSE')!.locked,true)
 assert.equal(draft.files.find(file=>file.path==='assets/sample.bin')!.locked,true)
 assert.deepEqual(f.atomic.files,before,'读取与派生草稿不能改原文件')
 assert.deepEqual(draft.origin.source,f.record.source)
})

test('编辑配套文本后固定新版本，二进制和许可逐字保留，来源可追溯且无执行',async()=>{
 const f=await fixture(),draft=await loadSkillDerivative(f.api,f.contentApi as any,f.record,'12345678')
 draft.files.find(file=>file.path==='references/guide.md')!.text='Receiver independently revised guide.\n'
 draft.files.find(file=>file.path==='scripts/check.py')!.text='print("never run during saving")\n'
 const license=draft.files.find(file=>file.path==='LICENSE')!;license.text='must not replace license';license.locked=false
 const binary=draft.files.find(file=>file.path==='assets/sample.bin')!;binary.text='must not replace binary';binary.locked=false
 const saved=await buildSkillDerivative(draft),again=await buildSkillDerivative(draft)
 assert.equal(saved.hash,again.hash,'同一草稿重试必须使用相同内容身份')
 assert.equal(saved.files.length,f.atomic.files.length,'不丢附件，也不另加文件挤占500文件上限')
 assert.deepEqual(saved.files.find(file=>file.path==='LICENSE')!.bytes,license.bytes)
 assert.deepEqual(saved.files.find(file=>file.path==='assets/sample.bin')!.bytes,binary.bytes)
 assert.equal(new TextDecoder().decode(saved.files.find(file=>file.path==='references/guide.md')!.bytes),'Receiver independently revised guide.\n')
 assert.match(saved.text,/teloa\.skill-derivation\/v1/);assert.ok(saved.text.includes(f.record.bundleHash));assert.match(saved.text,/Apache-2\.0/)
 assert.equal(f.atomic.text,text);assert.notEqual(saved.hash,f.atomic.hash)
})

test('来源变化、缺少附件或字节与摘要不符时拒绝派生',async()=>{
 const f=await fixture()
 await assert.rejects(()=>loadSkillDerivative({...f.api,preview:async()=>({...await f.api.preview(),bundleHash:'f'.repeat(64)})},f.contentApi as any,f.record),/来源或版本已变化/)
 await assert.rejects(()=>loadSkillDerivative({...f.api,preview:async()=>({...await f.api.preview(),files:(await f.api.preview()).files.slice(1)})},f.contentApi as any,f.record),/配套文件/)
 const changed=structuredClone(f.item);assert.ok('atomicSkill'in changed&&changed.atomicSkill);changed.atomicSkill.files[0]!.bytes=encode('corrupt')
 await assert.rejects(()=>loadSkillDerivative(f.api,{...f.contentApi,hydrate:async()=>changed} as any,f.record),/文件摘要/)
})

test('重新核验原安装本人身份，失败时不读取原固定正文',async()=>{
 const f=await fixture();let reads=0
 await assert.rejects(()=>loadSkillDerivative({...f.api,get:async()=>({...f.record,ownerId:'other-owner'})},{...f.contentApi,list:async()=>{reads++;return [f.item]}} as any,f.record),/不属于当前本人/)
 assert.equal(reads,0)
})

test('保存前拒绝同名覆盖和无效入口；源字节被篡改也不能固定为副本',async()=>{
 const f=await fixture(),draft=await loadSkillDerivative(f.api,f.contentApi as any,f.record,'12345678'),entry=draft.files.find(file=>file.path==='SKILL.md')!
 await assert.rejects(()=>buildSkillDerivative(draft,['my-evidence-review-12345678']),/独立技能名称/)
 entry.text=text;await assert.rejects(()=>buildSkillDerivative(draft),/独立技能名称/)
 entry.text=text.replace('evidence-review','my-review').replace('description: Review the provided evidence.\n','');await assert.rejects(()=>buildSkillDerivative(draft),/description/)
 entry.text=text.replace('evidence-review','my-review');draft.files.find(file=>file.path==='LICENSE')!.bytes=encode('changed');await assert.rejects(()=>buildSkillDerivative(draft),/文件摘要/)
})

test('合法最长原名和截断在连字符处的原名均可派生，仍通过既有入口解析',async()=>{
 for(const name of ['a'.repeat(120),'a'.repeat(84)+'-tail']){
  const f=await fixture('atomic',name),draft=await loadSkillDerivative(f.api,f.contentApi as any,f.record,'12345678'),saved=await buildSkillDerivative(draft)
  assert.ok(saved.id.length<=120);assert.match(saved.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
 }
})

const modelRequirement:IndustryModelDependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
for(const kind of ['atomic','industry-local','industry-public'] as const)test('派生'+kind+'完整保留该技能模型声明，不复制无关方案配置',async()=>{
 const extra:IndustryModelDependency={catalogId:'teloa.model.ocr',version:'2.0.0',usage:'ocr',required:false}
 const f=await fixture(kind,'evidence-review',[modelRequirement],kind==='industry-public'?[extra]:undefined)
 const draft=await loadSkillDerivative(f.api,f.contentApi as any,f.record,'12345678'),saved=await buildSkillDerivative(draft)
 assert.deepEqual(saved.modelDependencies,kind==='industry-public'?[modelRequirement,extra]:[modelRequirement])
 assert.ok(!JSON.stringify(saved.modelDependencies).includes('unrelated'))
 assert.deepEqual(f.atomic.modelDependencies,[modelRequirement])
})
test('同一模型用途的两个固定版本冲突不静默丢条件，明确拒绝派生',async()=>{
 const f=await fixture('industry-public','evidence-review',[modelRequirement],[{...modelRequirement,version:'2.0.0'}])
 await assert.rejects(loadSkillDerivative(f.api,f.contentApi as any,f.record),/模型版本要求冲突/)
})
test('旧原子技能省略依赖仍沿原摘要；显式空声明和运行配置拒绝进入元数据',async()=>{
 const f=await fixture(),metadata={id:f.atomic.id,title:f.atomic.title,version:f.atomic.version,categories:f.atomic.categories}
 assert.equal(f.atomic.hash,hash(JSON.stringify({metadata,files:f.atomic.files.map(file=>[file.path,file.hash])})))
 const inputs=sourceFiles.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes}))
 await assert.rejects(readAtomicSkill(inputs,{...metadata,modelDependencies:[]}),/模型依赖/)
 await assert.rejects(readAtomicSkill(inputs,{...metadata,modelDependencies:[{...modelRequirement,apiKey:'must-not-copy'} as any]}),/模型依赖/)
})

const sourceTrust={publisher:'Original author',repository:null,license:{status:'declared' as const,value:'Apache-2.0'},signature:{status:'verified' as const,signer:'original'},compatibility:{teloa:'0.2.10',dsh:'0.2.1-rc.2'},plugins:[{id:'specific-helper',version:'1.0.0',required:true}],externalCapabilities:[{id:'specific-service',kind:'connection' as const,required:true}],permissions:[{id:'read-evidence',description:'Read the specifically authorized evidence',required:true}],review:{conclusion:'approved' as const,summary:'Original source review'}}
test('atomic本体能力声明完整保留为待重新审查输入，不继承作者签名',async()=>{
 const f=await fixture();Object.assign(f.item,{trust:sourceTrust})
 const draft=await loadSkillDerivative(f.api,f.contentApi as any,f.record,'12345678'),saved=await buildSkillDerivative(draft)
 assert.deepEqual(draft.origin.requirements,{compatibility:sourceTrust.compatibility,plugins:sourceTrust.plugins,externalCapabilities:sourceTrust.externalCapabilities,permissions:sourceTrust.permissions})
 assert.equal(draft.origin.sourcePackageDeclarations,undefined)
 assert.ok(!JSON.stringify(draft.origin.requirements).includes('signature'));assert.ok(saved.text.includes('read-evidence'))
 assert.equal(sourceTrust.signature.status,'verified')
})
for(const kind of ['industry-local','industry-public'] as const)test(kind+'父包整体现有声明只保留待核历史，不冒称本技能要求',async()=>{
 const f=await fixture(kind)
 if(kind==='industry-local')Object.assign(f.item,{trust:sourceTrust})
 else{const parent=(await f.contentApi.list()).find((item:any)=>item.id==='public-parent')!;Object.assign(parent,{trust:sourceTrust});const originalHydrate=f.contentApi.hydrate;f.contentApi.hydrate=async(summary:any)=>summary.id==='public-parent'?parent:originalHydrate(summary)}
 const draft=await loadSkillDerivative(f.api,f.contentApi as any,f.record,'12345678'),saved=await buildSkillDerivative(draft)
 assert.equal(draft.origin.requirements,undefined)
 assert.deepEqual(draft.origin.sourcePackageDeclarations?.permissions,sourceTrust.permissions)
 assert.equal(draft.origin.sourcePackageDeclarations?.publisher,'Original author')
 assert.ok(saved.text.includes('sourcePackageDeclarations'));assert.ok(saved.text.includes('read-evidence'))
})
