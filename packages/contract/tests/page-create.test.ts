import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {pageCreateEntities,pageCreateLimits,readPageCreateBody,pageCreateCanonicalBody,pageCreateFieldRows,assertNoCredentialKeys,officialExtensionPackages,matchOfficialExtensions,readPageCreateAtomicSkillDraft,type PageCreateBodyReaders} from '../src/page-create.ts'

const objectType={format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警单',unit:'条',lead:'待处置告警',sourceId:'soc-alerts',fields:[{name:'severity',label:'级别',type:'enum',required:true,from:'级别',values:['高','低']}]}
const view={format:'teloa.business-view/v1',id:'soc-risk-distribution',version:'1.0.0',domain:'SOC',title:'风险分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',dimension:{field:'severity',limit:10},measures:[{id:'count',label:'条数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'count',direction:'desc'},limit:10}
const role={name:'SOC 调查岗',kind:'employee',scopes:['SOC'],duty:'调查告警',dataScope:'只读告警',executionScope:'不处置',skills:['alert-triage'],knowledge:['soc-runbook'],responsibility:{triggers:['新告警'],autonomousActions:['取证'],confirmationPoints:['处置前确认'],escalationRules:['高危升级'],deliveryChecks:['结论有依据']}}
const dataSource={format:'teloa.data-source/v1',sourceId:'soc-alerts',scopes:['SOC']}
const manifest={format:'teloa.business-package/v2',id:'my-soc',domain:'SOC'}
// 清单判据在客户端与后端，契约层不复制：测试注入一个原样透出的读取器，只证分派与拼装，不证清单判据。
const readers:PageCreateBodyReaders={manifest:value=>value,skill:value=>value}
const invalidInput=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'

test('六个 entity 各自分派到既有校验函数；entity 与正文形状不符即 invalid-input',()=>{
 assert.deepEqual([...pageCreateEntities],['business-definition','business-domain','role','skill','connector','extension'])
 assert.equal((readPageCreateBody('business-definition',objectType) as {id:string}).id,'alert-ticket')
 assert.equal((readPageCreateBody('business-definition',view) as {id:string}).id,'soc-risk-distribution')
 assert.equal((readPageCreateBody('role',role) as {name:string}).name,'SOC 调查岗')
 assert.deepEqual(readPageCreateBody('connector',{manifest,resource:dataSource},readers),{manifest,resource:dataSource})
 assert.deepEqual(readPageCreateBody('business-domain',{manifest,definitions:[objectType]},readers),{manifest,definitions:[readPageCreateBody('business-definition',objectType)]})
 assert.deepEqual(readPageCreateBody('skill',{id:'report',text:'# SKILL'},readers),{id:'report',text:'# SKILL'})
 // 形状不符一律由被分派到的既有 read* 判死，不在分派处另判一遍
 assert.throws(()=>readPageCreateBody('business-definition',role),invalidInput)
 assert.throws(()=>readPageCreateBody('role',objectType),invalidInput)
 assert.throws(()=>readPageCreateBody('extension',dataSource),invalidInput)
 // 白名单已清空：形状合法的官方包引用也一律拒绝，不是「形状对就收」
 assert.throws(()=>readPageCreateBody('extension',{registry:'npm',packageName:'dsh-visualize',version:'0.1.2'}),invalidInput)
 assert.throws(()=>readPageCreateBody('connector',{manifest,resource:objectType},readers),invalidInput)
 assert.throws(()=>readPageCreateBody('business-domain',{manifest,definitions:[]},readers),invalidInput)
 assert.throws(()=>readPageCreateBody('connector',{manifest,resource:dataSource,extra:1},readers),invalidInput)
})

test('清单与原子 Skill 判据不在契约层：缺注入即 dependency-unavailable，不悄悄少校验一层',()=>{
 for(const entity of ['business-domain','connector','skill'] as const){
  assert.throws(()=>readPageCreateBody(entity,{manifest,resource:dataSource,definitions:[objectType]}),(error:unknown)=>(error as {code?:string}).code==='teloa/dependency-unavailable')
 }
})

test('role 一支只创建数字员工：分身由个人空间默认提供，缺结构化职责即 invalid-input，未知字段即 invalid-input',()=>{
  const {responsibility,...withoutResponsibility}=role
  assert.ok(responsibility)
  assert.throws(()=>readPageCreateBody('role',withoutResponsibility),invalidInput)
  assert.throws(()=>readPageCreateBody('role',{...role,owner:'me'}),invalidInput)
  assert.deepEqual((readPageCreateBody('role',role) as {responsibility:unknown}).responsibility,responsibility)
  assert.throws(()=>readPageCreateBody('role',{...role,kind:'twin'}),(error:unknown)=>(error as {code?:unknown}).code==='teloa/conflict')
})

test('connector 一支的凭据键名一律拒绝：token / secret / password / apiKey / api_key / Bearer 六种写法',()=>{
 for(const key of ['token','secret','password','apiKey','api_key','Bearer']){
  assert.throws(()=>readPageCreateBody('connector',{manifest,resource:{...dataSource,[key]:'x'}},readers),invalidInput)
  assert.throws(()=>assertNoCredentialKeys({outer:[{[key]:'x'}]}),invalidInput)
 }
 // 只看键名不看取值：正常文本里出现这些词不算凭据
 assert.doesNotThrow(()=>assertNoCredentialKeys({lead:'password 过期的账号要复核',rows:[{note:'Bearer'}]}))
})

test('extension 一支不接受任何正文，只接受一条 {registry:"npm",packageName,version}',()=>{
 assert.throws(()=>readPageCreateBody('extension',{registry:'npm',packageName:'dsh-visualize',version:'0.1.2',format:'teloa.plugin/v1'}),invalidInput)
 assert.throws(()=>readPageCreateBody('extension',{registry:'github',packageName:'dsh-visualize',version:'0.1.2'}),invalidInput)
 assert.throws(()=>readPageCreateBody('extension',{registry:'npm',packageName:'dsh-visualize',version:'latest'}),invalidInput)
})

test('产品底座只用官方插件：officialExtensionPackages 为空，形状合法的第三方包一律回「没有匹配的官方扩展」',()=>{
 assert.deepEqual(officialExtensionPackages,[])
 assert.throws(()=>readPageCreateBody('extension',{registry:'npm',packageName:'dsh-visualize',version:'0.1.2'}),
  (error:unknown)=>invalidInput(error)&&(error as Error).message==='没有匹配的官方扩展。')
 assert.throws(()=>readPageCreateBody('extension',{registry:'npm',packageName:'left-pad',version:'1.3.0'}),
  (error:unknown)=>invalidInput(error)&&(error as Error).message==='没有匹配的官方扩展。')
})

test('Skill 草案只接收可序列化的文本文件目录：入口唯一、路径受限且不含凭据',()=>{
 const source=Buffer.from('---\nname: meeting-decisions\ndescription: 汇总会议纪要生成待办清单。\n---\n# 会议决议\n').toString('base64')
 const skill={id:'meeting-decisions',title:'会议决议',version:'1.0.0',categories:['meeting'],files:[{path:'meeting/SKILL.md',base64:source},{path:'meeting/README.md',base64:Buffer.from('说明').toString('base64')}]}
 assert.deepEqual(readPageCreateAtomicSkillDraft(skill),skill)
 assert.throws(()=>readPageCreateAtomicSkillDraft({...skill,files:[...skill.files,{path:'other/SKILL.md',base64:source}]}),invalidInput)
 assert.throws(()=>readPageCreateAtomicSkillDraft({...skill,files:[{path:'../SKILL.md',base64:source}]}),invalidInput)
 assert.throws(()=>readPageCreateAtomicSkillDraft({...skill,files:[{path:'meeting/SKILL.md',base64:'not-base64'}]}),invalidInput)
 assert.throws(()=>readPageCreateAtomicSkillDraft({...skill,files:[{path:'meeting/SKILL.md',base64:source}],token:'forbidden'}),invalidInput)
})

test('Skill 草案的入口 SKILL.md 必须带合规 frontmatter：name 与 id 相同且符合 DSH 命名规则，description 必填',()=>{
 const withFrontmatter=(name:string,description='测试技能。')=>Buffer.from('---\nname: '+name+'\ndescription: '+description+'\n---\n# 内容\n').toString('base64')
 const base={id:'meeting-decisions',title:'会议决议清单',version:'1.0.0',categories:['meeting'],files:[{path:'meeting-decisions/SKILL.md',base64:withFrontmatter('meeting-decisions')}]}
 // 合法草案通过
 assert.deepEqual(readPageCreateAtomicSkillDraft(base),base)
 // 中文 name 被拒，文案含「小写字母」（复现隔离宿主实跑发现的缺陷：DSH 原生解析器只认 kebab-case）
 assert.throws(()=>readPageCreateAtomicSkillDraft({...base,files:[{path:'meeting-decisions/SKILL.md',base64:withFrontmatter('会议决议清单')}]}),(error:unknown)=>invalidInput(error)&&(error as Error).message.includes('小写字母'))
 // name 与草案 id 不同被拒，即便 name 本身合规
 assert.throws(()=>readPageCreateAtomicSkillDraft({...base,files:[{path:'meeting-decisions/SKILL.md',base64:withFrontmatter('other-name')}]}),invalidInput)
 // 无 frontmatter 被拒
 assert.throws(()=>readPageCreateAtomicSkillDraft({...base,files:[{path:'meeting-decisions/SKILL.md',base64:Buffer.from('# 没有 frontmatter\n').toString('base64')}]}),invalidInput)
 // SKILL.md 内容不是有效 UTF-8 被拒
 assert.throws(()=>readPageCreateAtomicSkillDraft({...base,files:[{path:'meeting-decisions/SKILL.md',base64:Buffer.from([0xc3,0x28]).toString('base64')}]}),invalidInput)
})

test('规范化正文稳定且可再解析：键序打乱后逐字相同，再规范化一次不变，且 ≤ bodyBytes',()=>{
 const definition=readPageCreateBody('business-definition',view)
 const once=pageCreateCanonicalBody(definition)
 assert.equal(pageCreateCanonicalBody({...definition as Record<string,unknown>,format:view.format,measures:[...view.measures]}),once)
 assert.equal(pageCreateCanonicalBody(JSON.parse(once)),once)
 assert.ok(Buffer.byteLength(once)<=pageCreateLimits.bodyBytes)
 assert.throws(()=>pageCreateCanonicalBody({...definition as Record<string,unknown>,title:'风'.repeat(pageCreateLimits.bodyBytes)}),invalidInput)
})

test('字段表按数组下标与嵌套键展开、数组保序，超过 fieldRows 时由调用方截断而不是本函数静默丢',()=>{
 const rows=pageCreateFieldRows(readPageCreateBody('business-definition',objectType))
 assert.deepEqual(rows.filter(row=>row.path.startsWith('fields[0].values')),[{path:'fields[0].values[0]',value:'"高"'},{path:'fields[0].values[1]',value:'"低"'}])
 assert.equal(rows.find(row=>row.path==='fields[0].required')?.value,'true')
 assert.equal(rows.some(row=>row.path==='fields[0].referenceType'),false)
 // 本函数不看上限：行数照实回，截断与 fieldsTruncated 由预览层负责
 const wide=pageCreateFieldRows({rows:Array.from({length:pageCreateLimits.fieldRows+5},(_,index)=>index)})
 assert.equal(wide.length,pageCreateLimits.fieldRows+5)
 assert.equal(wide[0]?.path,'rows[0]')
})

test('官方扩展白名单已清空：matchOfficialExtensions 对任何一句话都回空数组，不猜包名',()=>{
 assert.deepEqual(officialExtensionPackages,[])
 assert.deepEqual(matchOfficialExtensions('帮我做一个可视化看板'),[])
 assert.deepEqual(matchOfficialExtensions('装一个能连交易所的插件'),[])
 assert.deepEqual(matchOfficialExtensions(''),[])
 assert.deepEqual(matchOfficialExtensions('chart'),[])
})

test('浏览器验收夹具镜像官方扩展白名单，避免白名单外的扩展被错误推荐',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../tests/fixtures/页内新建/官方扩展白名单.json',import.meta.url),'utf8'))
 assert.deepEqual(fixture,officialExtensionPackages)
})

test('pageCreateLimits 四个值是字面量且不可写',()=>{
 assert.deepEqual({...pageCreateLimits},{bodyBytes:131072,draftsPerEntity:16,fieldRows:200,consequences:64})
 // 写这一位即编译报错（`as const` 的四个字面量，不做设置项）；这段只做类型层的钉子，永不执行，免得改坏别的用例
 const write=()=>{
  // @ts-expect-error pageCreateLimits 的每一位都是 readonly 字面量
  pageCreateLimits.fieldRows=1
 }
 assert.equal(typeof write,'function')
})
