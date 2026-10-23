import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as share from '../src/template-share.mjs'
const {readTemplateSharePackage,canonicalTemplateShare,templateShareDigest}=share

const id='52f53c5e-9c13-4972-a657-98e1cdef891f'
export function sample(){return {format:'teloa.template-share/v1',id,version:'1.0.0',title:'Research assistant',description:'Prepare reviewed research.',requirements:[],compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:['people']},files:[{path:'teloa.json',text:JSON.stringify({format:'teloa.business-package/v2',id,version:'1.0.0',title:'Research assistant',description:'Prepare reviewed research.',domain:'general',scope:'general',resources:[{id:'employee',kind:'role',title:'Research assistant',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}}],relations:[],entrypoints:[]})},{path:'role.json',text:JSON.stringify({format:'teloa.role/v1',kind:'employee',name:'Research assistant',duty:'Use the user locale. Check sources.',dataScope:'User-provided material.',executionScope:'Ask before publishing.'})}]}}
const changeManifest=(p,fn)=>{const f=p.files.find(f=>f.path==='teloa.json');const v=JSON.parse(f.text);fn(v);f.text=JSON.stringify(v);return p}
test('an employee template preserves a built-in avatar and includes it in the fixed digest',async()=>{
 const p=sample(),file=p.files.find(f=>f.path==='role.json'),original=await templateShareDigest(p)
 file.text=JSON.stringify({...JSON.parse(file.text),avatarKey:'security-analyst'})
 const checked=readTemplateSharePackage(p)
 assert.equal(JSON.parse(checked.files.find(f=>f.path==='role.json').text).avatarKey,'security-analyst')
 assert.notEqual(await templateShareDigest(checked),original)
 for(const avatarKey of ['https://example.com/avatar.png','custom',null,{}]){
  const invalid=structuredClone(p);invalid.files.find(f=>f.path==='role.json').text=JSON.stringify({...JSON.parse(file.text),avatarKey})
  assert.throws(()=>readTemplateSharePackage(invalid),/avatar/i)
 }
})
test('free-combination avatars pass v1 and v2 employee templates unchanged; ink is supported and unknown shapes are rejected',()=>{
 const p=sample(),file=p.files.find(f=>f.path==='role.json')
 file.text=JSON.stringify({...JSON.parse(file.text),avatarKey:'bot:ghost:amber'})
 assert.equal(JSON.parse(readTemplateSharePackage(p).files.find(f=>f.path==='role.json').text).avatarKey,'bot:ghost:amber')
 const v2=employee(),role=v2.files.find(f=>f.path==='roles/lead.json')
 role.text=JSON.stringify({...JSON.parse(role.text),avatarKey:'bot:capsule:plum'})
 assert.equal(JSON.parse(share.readTemplateSharePackageV2(v2).files.find(f=>f.path==='roles/lead.json').text).avatarKey,'bot:capsule:plum')
 const ink=structuredClone(p);ink.files.find(f=>f.path==='role.json').text=JSON.stringify({...JSON.parse(file.text),avatarKey:'bot:circle:ink'})
 assert.equal(JSON.parse(readTemplateSharePackage(ink).files.find(f=>f.path==='role.json').text).avatarKey,'bot:circle:ink')
 for(const avatarKey of ['bot:star:teal','bot:circle','bot:circle:teal:x','BOT:circle:teal']){
  const invalid=structuredClone(p);invalid.files.find(f=>f.path==='role.json').text=JSON.stringify({...JSON.parse(file.text),avatarKey})
  assert.throws(()=>readTemplateSharePackage(invalid),/avatar/i,avatarKey)
 }
})
test('canonical contents are independent of file ordering, and digest detects edits',async()=>{const p=sample(),q=structuredClone(p);q.files.reverse();assert.equal(canonicalTemplateShare(p),canonicalTemplateShare(q));assert.equal(await templateShareDigest(p),await templateShareDigest(q));q.description='Another purpose';assert.notEqual(await templateShareDigest(p),await templateShareDigest(q));assert.deepEqual(readTemplateSharePackage(p).requirements,[])})
test('source identity, runtime configuration and undeclared private fields cannot pass',()=>{for(const key of ['ownerId','roleId','runtimeConfig','memory']){const p=sample();p[key]='private';assert.throws(()=>readTemplateSharePackage(p))}const p=sample();const f=p.files.find(f=>f.path==='role.json');const v=JSON.parse(f.text);v.runtimeConfig={modelAccountId:'private'};f.text=JSON.stringify(v);assert.throws(()=>readTemplateSharePackage(p))})
test('unsafe, duplicate, hidden and executable paths are rejected',()=>{for(const path of ['../a.md','/a.md','.env','a/.secret.md','a\\b.md','a%2fb.md','run.js','run.sh']){const p=sample();p.files.push({path,text:'hello'});assert.throws(()=>readTemplateSharePackage(p),path)}const p=sample();p.files.push(p.files[1]);assert.throws(()=>readTemplateSharePackage(p))})
test('manifest identity, resource closure and unique employee are enforced',()=>{for(const fn of [v=>v.id='other',v=>v.version='2.0.0',v=>v.resources[0].source.path='missing.json',v=>v.resources[0].kind='plugin',v=>v.resources.push({...v.resources[0],id:'another'}),v=>v.relations.push({kind:'role-skill',from:'employee',to:'absent'}),v=>v.entrypoints.push('employee')])assert.throws(()=>readTemplateSharePackage(changeManifest(sample(),fn)));const p=sample();const f=p.files.find(f=>f.path==='role.json');f.text=f.text.replace('employee','twin');assert.throws(()=>readTemplateSharePackage(p))})
test('remote references and unknown necessary capability cannot silently downgrade',()=>{assert.throws(()=>readTemplateSharePackage(changeManifest(sample(),v=>v.resources[0].source={kind:'public',id:'external',version:'1.0.0'})));const p=sample();p.compatibility.capabilities.push('host.admin');assert.throws(()=>readTemplateSharePackage(p));const q=sample();q.compatibility.capabilities=[];assert.throws(()=>readTemplateSharePackage(q))})
test('text secrets, local paths and actual UTF8 byte limits are checked',()=>{for(const text of ['My directory is /Users/example/private','API_KEY=abcdefghijklmnopqrstuv123456','-----BEGIN PRIVATE KEY-----']){const p=sample();p.files.push({path:'README.md',text});assert.throws(()=>readTemplateSharePackage(p))}const p=sample();p.files.push({path:'README.md',text:'中'.repeat(90000)});assert.throws(()=>readTemplateSharePackage(p))})

// ---- teloa.template-share/v2：AI 员工、AI 团队与单独能力共用 business-package 容器 ----
const V1_SAMPLE_DIGEST='f01f23b7c36246773fc7200324e5237780c8b3f93b9aa493031b327f3db81260'
const roleText=name=>JSON.stringify({format:'teloa.role/v1',kind:'employee',name,duty:'Use the user locale.',dataScope:'User-provided material.',executionScope:'Ask before publishing.'})
const res=(id,kind,path,extra={})=>({id,kind,title:id,version:'1.0.0',required:true,source:{kind:'local',path},...extra})
const mcpBody=JSON.stringify({format:'teloa.mcp-connection/v1',serverName:'github',tools:['read_item']})
const pluginBody=JSON.stringify({format:'teloa.plugin/v1',registry:'npm',packageName:'@example/helper',version:'2.1.0'})
const skillBody='---\nname: review\ndescription: Review.\n---\n\nReview material.'
function v2(subject,{resources,relations=[],entrypoints=[],files,id='research-team',manifestFormat='teloa.business-package/v2',capabilities=['people'],extra={}}){
 return {format:'teloa.template-share/v2',subject,id,version:'1.0.0',title:'Research',description:'Prepare reviewed research.',requirements:[],license:'MIT',trust:{publisher:'Example author'},provenance:{sources:[]},sourceFiles:[],compatibility:{manifestFormat,capabilities},...extra,files:[{path:'teloa.json',text:JSON.stringify({format:manifestFormat,id,version:'1.0.0',title:'Research',description:'Prepare reviewed research.',domain:'general',scope:'general',resources,relations,entrypoints})},...files]}
}
const employee=()=>v2('employee',{resources:[res('lead','role','roles/lead.json'),res('review','skill','skills/review/SKILL.md')],relations:[{kind:'role-skill',from:'lead',to:'review'}],entrypoints:['review'],files:[{path:'roles/lead.json',text:roleText('Lead')},{path:'skills/review/SKILL.md',text:skillBody}]})
const team=()=>v2('team',{resources:[res('lead','role','roles/lead.json'),res('writer','role','roles/writer.json'),res('review','skill','skills/review/SKILL.md'),res('github','mcp','connections/github.json',{required:false})],relations:[{kind:'role-skill',from:'lead',to:'review'},{kind:'role-skill',from:'writer',to:'review'},{kind:'role-connection',from:'writer',to:'github'}],entrypoints:['review'],capabilities:['people','connections'],extra:{team:{coordinatorResourceId:'lead'}},files:[{path:'roles/lead.json',text:roleText('Lead')},{path:'roles/writer.json',text:roleText('Writer')},{path:'skills/review/SKILL.md',text:skillBody},{path:'connections/github.json',text:mcpBody}]})
const app=()=>v2('app',{resources:[res('review','skill','skills/review/SKILL.md'),res('github','mcp','connections/github.json'),{...res('helper','plugin','connections/helper.json'),version:'2.1.0'}],capabilities:['connections'],entrypoints:['review'],files:[{path:'skills/review/SKILL.md',text:skillBody},{path:'connections/github.json',text:mcpBody},{path:'connections/helper.json',text:pluginBody}]})
const skill=()=>v2('skill',{resources:[res('review','skill','skills/review/SKILL.md')],capabilities:[],entrypoints:['review'],files:[{path:'skills/review/SKILL.md',text:skillBody}],extra:{license:'Apache-2.0',provenance:{sources:[{title:'Example skills',url:'https://github.com/example/skills',version:'1.2.0',license:'Apache-2.0',resourceIds:['review']}],modifications:'Translated the headings.'}}})
const mcp=()=>v2('mcp',{resources:[res('github','mcp','connections/github.json')],capabilities:['connections'],files:[{path:'connections/github.json',text:mcpBody}]})
const subjects={employee,team,app,skill,mcp}
const editV2=(p,fn)=>{const f=p.files.find(f=>f.path==='teloa.json');const v=JSON.parse(f.text);fn(v);f.text=JSON.stringify(v);return p}
const setFile=(p,path,text)=>{const f=p.files.find(f=>f.path===path);if(f)f.text=text;else p.files.push({path,text});return p}
const dropFile=(p,path)=>{p.files=p.files.filter(f=>f.path!==path);return p}
const readAny=value=>share.readTemplateShare(value)
const rejects=(make,label)=>assert.throws(()=>readAny(make()),undefined,label)

test('v2 employee and team templates preserve structured duties without admitting private runtime fields',async()=>{
 const p=employee(),f=p.files.find(file=>file.path==='roles/lead.json')??p.files.find(file=>file.path!=='teloa.json'),original=await templateShareDigest(p)
 const responsibilities={triggers:['本人交付目标'],autonomousActions:['整理事实与未知'],confirmationPoints:['外发成果前'],escalationRules:['资料缺失'],deliveryChecks:['判据可验']}
 f.text=JSON.stringify({...JSON.parse(f.text),responsibility:responsibilities})
 const parsed=readAny(p)
 assert.deepEqual(JSON.parse(parsed.files.find(file=>file.path===f.path).text).responsibility,responsibilities)
 assert.notEqual(await templateShareDigest(parsed),original)
 for(const invalid of [{...responsibilities,ownerId:'private'},{...responsibilities,triggers:'not an array'},{...responsibilities,deliveryChecks:[]}]){
  const next=structuredClone(p);next.files.find(file=>file.path===f.path).text=JSON.stringify({...JSON.parse(f.text),responsibility:invalid})
  if(Array.isArray(invalid.deliveryChecks)&&invalid.deliveryChecks.length===0)assert.doesNotThrow(()=>readAny(next))
  else assert.throws(()=>readAny(next))
 }
 const legacy=sample();legacy.files.find(file=>file.path==='role.json').text=JSON.stringify({...JSON.parse(legacy.files.find(file=>file.path==='role.json').text),responsibility:responsibilities})
 assert.throws(()=>readTemplateSharePackage(legacy))
})

test('the original v1 reader still rejects multiple employees, single capabilities and slug identities',()=>{
 const asV1=p=>{const {subject,license,trust,provenance,sourceFiles,team:_team,...rest}=p;return {...rest,format:'teloa.template-share/v1',id}}
 const teamV1=editV2(asV1(team()),m=>{m.id=id});teamV1.compatibility.capabilities=['people']
 assert.throws(()=>readTemplateSharePackage(teamV1),undefined,'v1 只能有一个员工')
 assert.throws(()=>readTemplateSharePackage(editV2(asV1(skill()),m=>{m.id=id})),undefined,'v1 不能只分享一个技能')
 assert.throws(()=>readTemplateSharePackage({...sample(),id:'grok-recipe-0123456789abcdef'}),undefined,'v1 只接受 UUID')
 for(const make of Object.values(subjects))assert.throws(()=>readTemplateSharePackage(make()),undefined,'v1 读取器不接收 v2')
})
test('v1 canonical bytes and digest are unchanged, and v2-only fields are not accepted in v1',async()=>{
 assert.equal(await templateShareDigest(sample()),V1_SAMPLE_DIGEST)
 assert.equal(canonicalTemplateShare(sample()).includes('subject'),false)
 assert.equal(readAny(sample()).format,'teloa.template-share/v1')
 for(const [key,value] of [['subject','employee'],['license','MIT'],['sourceFiles',[]],['team',{coordinatorResourceId:'employee'}]])assert.throws(()=>readTemplateSharePackage({...sample(),[key]:value}),undefined,key)
})
test('v2 accepts employee, team, app, skill and mcp through the same business-package container',async()=>{
 for(const [subject,make] of Object.entries(subjects)){
  const p=make(),q=structuredClone(p);q.files.reverse()
  const checked=share.readTemplateSharePackageV2(p)
  assert.equal(checked.subject,subject);assert.equal(readAny(p).subject,subject)
  assert.equal(canonicalTemplateShare(p),canonicalTemplateShare(q),subject)
  assert.match(await templateShareDigest(p),/^[a-f0-9]{64}$/)
  assert.equal(await templateShareDigest(checked),await templateShareDigest(q))
 }
 assert.deepEqual(readAny(team()).team,{coordinatorResourceId:'lead'})
 assert.equal(readAny({...team(),team:undefined}).team,undefined,'团队协调者是可选外壳元数据，不按 entrypoint 猜测')
 assert.equal(readAny(editV2({...employee(),id},m=>{m.id=id})).id,id,'UUID 仍是合法的分享身份')
})
test('v2 digest covers subject, license, trust, provenance, source files and team metadata',async()=>{
 const base=await templateShareDigest(team()),canonical=canonicalTemplateShare(team())
 for(const key of ['"subject":"team"','"license":"MIT"','"publisher":"Example author"','"sourceFiles":[]','"coordinatorResourceId":"lead"'])assert.ok(canonical.includes(key),key)
 const variants=[p=>{p.license='Apache-2.0'},p=>{p.trust.publisher='Another author'},p=>{p.team.coordinatorResourceId='writer'},p=>{p.provenance.modifications='Shortened the duty.'},p=>{p.sourceFiles=['source/notes.json'];p.files.push({path:'source/notes.json',text:'{"note":"original"}'})}]
 for(const change of variants){const p=team();change(p);assert.notEqual(await templateShareDigest(p),base,String(change))}
})
test('v2 subject shape: one employee, at least two team members, no role in single capabilities',()=>{
 rejects(()=>setFile(editV2(employee(),m=>{m.resources.push(res('twin','role','roles/twin.json'))}),'roles/twin.json',roleText('Twin')),'员工只能一个')
 rejects(()=>dropFile(editV2(employee(),m=>{m.resources=m.resources.filter(r=>r.kind!=='role');m.relations=[]}),'roles/lead.json'),'员工至少一个')
 rejects(()=>({...employee(),team:{coordinatorResourceId:'lead'}}),'员工不带团队外壳')
 rejects(()=>dropFile(editV2({...team(),team:undefined},m=>{m.resources=m.resources.filter(r=>r.id!=='writer');m.relations=m.relations.filter(r=>r.from!=='writer')}),'roles/writer.json'),'团队至少两人')
 for(const coordinatorResourceId of ['review','absent','',' lead'])rejects(()=>({...team(),team:{coordinatorResourceId}}),'协调者必须是已声明员工 '+coordinatorResourceId)
 rejects(()=>({...team(),team:{coordinatorResourceId:'lead',entrypoint:'review'}}),'团队外壳不收未知字段')
 rejects(()=>setFile(editV2(app(),m=>{m.resources.push(res('lead','role','roles/lead.json'))}),'roles/lead.json',roleText('Lead')),'应用不含员工')
 rejects(()=>v2('app',{resources:[res('notes','knowledge','notes.md')],capabilities:[],files:[{path:'notes.md',text:'Notes'}]}),'应用至少一个技能/MCP/插件')
 rejects(()=>setFile(editV2(skill(),m=>{m.resources.push(res('second','skill','skills/second/SKILL.md'))}),'skills/second/SKILL.md',skillBody),'技能恰好一个')
 rejects(()=>setFile(editV2(skill(),m=>{m.resources.push(res('github','mcp','connections/github.json'))}),'connections/github.json',mcpBody),'技能不夹带连接')
 rejects(()=>setFile(editV2(mcp(),m=>{m.resources.push(res('gitlab','mcp','connections/gitlab.json'))}),'connections/gitlab.json',mcpBody),'MCP 恰好一个')
 rejects(()=>setFile(editV2(mcp(),m=>{m.resources.push(res('review','skill','skills/review/SKILL.md'))}),'skills/review/SKILL.md',skillBody),'MCP 不夹带技能')
 rejects(()=>editV2(employee(),m=>{m.resources.push(res('copy','skill','skills/review/SKILL.md'))}),'两个资源不能共用同一文件')
 for(const subject of ['bot','business',undefined])rejects(()=>({...employee(),subject}),'未知主题 '+subject)
})
test('v2 source files must be explicitly declared, present, under source/ and valid JSON',()=>{
 const withSource=(declared,files=[{path:'source/recipe.json',text:'{"profile":{}}'}])=>{const p=employee();p.sourceFiles=declared;p.files.push(...files);return p}
 assert.deepEqual(readAny(withSource(['source/recipe.json'])).sourceFiles,['source/recipe.json'])
 rejects(()=>withSource([]),'未声明 JSON 仍拒绝')
 rejects(()=>withSource(['source/recipe.json','source/import.json']),'声明的来源必须存在')
 rejects(()=>withSource(['source/recipe.json','source/recipe.json']),'来源不能重复')
 rejects(()=>withSource(['roles/extra.json'],[{path:'roles/extra.json',text:'{}'}]),'只接受 source/ 目录')
 rejects(()=>withSource(['source/../roles/lead.json']),'路径不安全')
 rejects(()=>withSource(['source/nested/recipe.json'],[{path:'source/nested/recipe.json',text:'{}'}]),'只接受一级来源文件')
 rejects(()=>withSource(['source/recipe.json'],[{path:'source/recipe.json',text:'{not json'}]),'来源须为有效 JSON')
 rejects(()=>withSource(['source/notes.md'],[{path:'source/notes.md',text:'notes'}]),'来源声明只用于 JSON')
 rejects(()=>{const p=withSource(['source/recipe.json']);editV2(p,m=>{m.resources.push(res('extra','work-template','source/recipe.json'))});return p},'来源文件不能同时是资源')
 rejects(()=>({...employee(),sourceFiles:'source/recipe.json'}),'来源声明必须是列表')
})
test('v2 connections, plugins, business structures and pinned public references keep their real declarations',()=>{
 rejects(()=>setFile(mcp(),'connections/github.json',JSON.stringify({format:'teloa.mcp-connection/v1',serverName:'github',tools:['read_item'],url:'https://example.com/mcp'})),'MCP 不携带运行地址')
 rejects(()=>setFile(mcp(),'connections/github.json',JSON.stringify({format:'teloa.mcp-connection/v1',serverName:'github',tools:['read_item'],env:{TOKEN:'x'}})),'MCP 不携带环境变量')
 rejects(()=>setFile(mcp(),'connections/github.json',JSON.stringify({format:'other',serverName:'github',tools:['read_item']})),'MCP 格式固定')
 rejects(()=>dropFile(mcp(),'connections/github.json'),'单独分享的 MCP 必须有正文')
 rejects(()=>setFile(app(),'connections/helper.json',JSON.stringify({format:'teloa.plugin/v1',registry:'npm',packageName:'@example/helper',version:'^2.1.0'})),'插件版本必须精确')
 rejects(()=>setFile(app(),'connections/helper.json',JSON.stringify({format:'teloa.plugin/v1',registry:'npm',packageName:'@example/helper',version:'2.2.0'})),'插件版本与资源声明一致')
 assert.equal(readAny(dropFile(team(),'connections/github.json')).subject,'team','非必需连接可只声明不提供')
 rejects(()=>dropFile(editV2(team(),m=>{m.resources.find(r=>r.id==='github').required=true}),'connections/github.json'),'必需资源必须存在')
 rejects(()=>{const p=team();p.compatibility.capabilities=['people'];return p},'连接资源需要 connections 能力')
 rejects(()=>{const p=employee();p.compatibility.capabilities=['people','host.admin'];return p},'未知能力拒绝')
 rejects(()=>{const p=employee();p.compatibility.capabilities=[];return p},'员工需要 people 能力')
 const pinned=()=>dropFile(editV2(skill(),m=>{m.resources[0].source={kind:'public',id:'official-review',version:'1.0.0'}}),'skills/review/SKILL.md')
 assert.equal(readAny({...pinned(),provenance:{sources:[]}}).subject,'skill','固定公共技能引用')
 rejects(()=>editV2({...pinned(),provenance:{sources:[]}},m=>{m.resources[0].source.version='1.1.0'}),'公共引用版本必须一致')
 rejects(()=>editV2({...pinned(),provenance:{sources:[]}},m=>{m.resources[0].source.url='https://example.com'}),'公共引用不收地址')
 rejects(()=>pinned(),'出处只描述包内实际携带的资源')
 rejects(()=>dropFile(editV2(mcp(),m=>{m.resources[0].source={kind:'public',id:'official-github',version:'1.0.0'}}),'connections/github.json'),'MCP 不能用公共引用代替正文')
 const config=format=>v2('team',{manifestFormat:format,capabilities:['people','business'],resources:[res('lead','role','roles/lead.json'),res('writer','role','roles/writer.json'),res('board','business-configuration','business/board.json'),res('ticket','object-type','business/ticket.json')],files:[{path:'roles/lead.json',text:roleText('Lead')},{path:'roles/writer.json',text:roleText('Writer')},{path:'business/board.json',text:JSON.stringify({format:'teloa.business-dashboard-resource/v1',id:'board',version:'1.0.0',configuration:{scope:'general',definitions:[]}})},{path:'business/ticket.json',text:'{"format":"teloa.object-type/v1"}'}]})
 assert.equal(readAny(config('teloa.business-package/v4')).subject,'team','团队可带现有业务结构，不强制新建业务')
 rejects(()=>config('teloa.business-package/v2'),'完整业务配置仅限 v4 容器')
 rejects(()=>{const p=config('teloa.business-package/v4');p.compatibility.capabilities=['people'];return p},'业务结构需要 business 能力')
})
test('v2 license, trust and provenance are explicit and private data stays out',()=>{
 rejects(()=>{const p=skill();delete p.license;return p},'许可必填')
 rejects(()=>({...skill(),license:''}),'许可不能为空')
 rejects(()=>({...skill(),trust:{publisher:'Teloa 官方目录'}}),'不能冒用官方发布者')
 rejects(()=>({...skill(),trust:{publisher:'Example',verified:true}}),'信任信息不收自报核验')
 rejects(()=>{const p=skill();p.provenance.sources[0].resourceIds=['absent'];return p},'出处必须指向已声明资源')
 rejects(()=>{const p=skill();p.provenance.sources[0].resourceIds=[];return p},'出处必须指向至少一个资源')
 rejects(()=>{const p=skill();p.provenance.sources[0].url='http://github.com/example/skills';return p},'出处地址必须是 https')
 rejects(()=>{const p=skill();delete p.provenance.sources[0].license;return p},'第三方出处必须保留许可')
 rejects(()=>{const p=skill();p.provenance.modifications='Replaced api_key=abcdefghijklmnopqrstuv123456';return p},'修改说明也做凭据筛查')
 rejects(()=>setFile(employee(),'README.md','Copied from /Users/example/private/skills'),'本机路径拒绝')
 rejects(()=>setFile(employee(),'skills/review/SKILL.md',skillBody+'\nghp_abcdefghijklmnopqrstuvwxyz0123'),'凭据拒绝')
 for(const key of ['ownerId','accountId','runtimeConfig','memory','credentials','history'])rejects(()=>({...team(),[key]:'private'}),key)
 rejects(()=>setFile(employee(),'roles/lead.json',JSON.stringify({...JSON.parse(roleText('Lead')),runtimeConfig:{modelAccountId:'private'}})),'员工不携带运行配置')
 for(const value of ['bad/id','../x','-lead','a'.repeat(121),'空格 id'])rejects(()=>editV2({...employee(),id:value},m=>{m.id=value}),'分享身份 '+value)
 rejects(()=>editV2(employee(),m=>{m.id='other-id'}),'清单身份必须一致')
 rejects(()=>setFile(employee(),'big.md','a'.repeat(2*1024*1024+1)),'单文件上限')
})
test('v2 review regressions: runtime configuration, impersonation, link credentials, case bypass and empty apps',()=>{
 const withConnection=(kind,body,extra={})=>setFile(editV2(employee(),m=>{m.resources.push({...res('conn',kind,'connections/conn.json'),...extra})}),'connections/conn.json',JSON.stringify(body))
 const connections=p=>{p.compatibility.capabilities=['people','connections'];return p}
 assert.equal(readAny(connections(withConnection('data-source',{format:'teloa.data-source/v1',sourceId:'crm.tickets',scopes:['support']}))).subject,'employee')
 rejects(()=>connections(withConnection('data-source',{url:'https://internal.example/api',headers:{Authorization:'Bearer abcdef'}})),'数据源不收地址与请求头')
 rejects(()=>connections(withConnection('execution-tool',{format:'teloa.execution-tool/v1',adapterId:'custom-http',tools:['run']})),'执行工具只收已审声明')
 rejects(()=>setFile(mcp(),'connections/github.json',JSON.stringify({format:'teloa.mcp-connection/v1',serverName:'github',tools:['read_item'],pad:'x'})),'MCP 未知字段')
 rejects(()=>setFile(mcp(),'connections/github.json',mcpBody.slice(0,-1)+' '.repeat(128*1024)+'}'),'连接声明上限 128 KiB')
 const board=configuration=>v2('team',{manifestFormat:'teloa.business-package/v4',capabilities:['people','business'],resources:[res('lead','role','roles/lead.json'),res('writer','role','roles/writer.json'),res('board','business-configuration','business/board.json')],files:[{path:'roles/lead.json',text:roleText('Lead')},{path:'roles/writer.json',text:roleText('Writer')},{path:'business/board.json',text:JSON.stringify({format:'teloa.business-dashboard-resource/v1',id:'board',version:'1.0.0',configuration})}]})
 rejects(()=>board({scope:'other',definitions:[]}),'业务配置范围必须与清单一致')
 rejects(()=>board({scope:'general',definitions:[{kind:'source-mapping',definition:{}}]}),'业务配置不携带已有同步绑定')
 rejects(()=>setFile(editV2(employee(),m=>{m.resources.push(res('view','business-view','business/view.json'))}),'business/view.json','{"url":"https://example.com"}'),'业务结构只收本类型格式')
 for(const publisher of ['Teloa　官方目录','Teloa 官方目录​','Teloa  官方目录','teloa 官方目录'])rejects(()=>({...employee(),trust:{publisher}}),'官方发布者变体 '+JSON.stringify(publisher))
 rejects(()=>{const p=skill();p.provenance.sources[0].url='https://admin:hunter2pass@git.example.com/r';return p},'出处链接不带账号密码')
 for(const name of ['config.JSON','source/recipe.Json'])rejects(()=>setFile(employee(),name,'{}'),'扩展名大小写不能绕过声明 '+name)
 rejects(()=>dropFile(v2('app',{resources:[res('github','mcp','connections/github.json',{required:false})],capabilities:['connections'],files:[]}),'connections/github.json'),'应用必须实际包含能力')
 const model=deps=>editV2({...employee(),compatibility:{manifestFormat:'teloa.business-package/v3',capabilities:['people']}},m=>{m.format='teloa.business-package/v3';m.resources[1].modelDependencies=deps})
 assert.equal(readAny(model([{catalogId:'qwen.embedding',version:'1.0.0',usage:'embedding',required:true}])).subject,'employee')
 for(const deps of [[{}],[{catalogId:'qwen.embedding',version:'1.0.0',usage:'teleport',required:true}],[{catalogId:'qwen.embedding',version:'1.0.0',usage:'embedding',required:true},{catalogId:'qwen.embedding',version:'1.1.0',usage:'embedding',required:false}],[{catalogId:'qwen.embedding',version:'1.0.0',usage:'embedding',required:true,url:'https://example.com/model.bin'}]])rejects(()=>model(deps),'模型依赖 '+JSON.stringify(deps))
 assert.equal(readAny(editV2(employee(),m=>{delete m.scope})).subject,'employee','缺省 scope 与业务包容器一致取 domain')
})
test('submission receipts carry the fixed digest and a review state only',()=>{
 const row={shareId:id,sha256:V1_SAMPLE_DIGEST,state:'pending',submittedAt:'2026-10-14T08:00:00.000Z'}
 for(const state of ['pending','approved','rejected','withdrawn'])assert.equal(share.readTemplateShareSubmission({...row,state}).state,state)
 assert.equal(share.readTemplateShareSubmission({...row,state:'rejected',reviewedAt:'2026-10-15T08:00:00.000Z',reason:'License text is missing.'}).reason,'License text is missing.')
 for(const bad of [{state:'published'},{sha256:V1_SAMPLE_DIGEST.toUpperCase()},{sha256:'abc'},{shareId:'grok-recipe-1'},{submittedAt:'yesterday'},{listed:true},{reviewedAt:'2026-10-13T08:00:00.000Z'},{reason:'Missing license.'}])assert.throws(()=>share.readTemplateShareSubmission({...row,...bad}),undefined,JSON.stringify(bad))
})

test('v2 能力缺失指明应声明的能力与资源类型，供页内新建如实修正',()=>{
 const p=app();p.compatibility.capabilities=[]
 assert.throws(()=>readAny(p),/undeclared capability[^\n]*connections[^\n]*mcp/)
 assert.equal(share.templateShareResourceCapability('mcp'),'connections')
 assert.equal(share.templateShareResourceCapability('role'),'people')
 assert.equal(share.templateShareResourceCapability('plan'),'automation')
 assert.equal(share.templateShareResourceCapability('skill'),undefined)
})
test('an employee declares the apps it depends on through role-connection to a plugin',()=>{
 const p=v2('employee',{resources:[res('lead','role','roles/lead.json'),{...res('helper','plugin','connections/helper.json'),version:'2.1.0'}],relations:[{kind:'role-connection',from:'lead',to:'helper'}],capabilities:['people','connections'],files:[{path:'roles/lead.json',text:roleText('Lead')},{path:'connections/helper.json',text:pluginBody}]})
 assert.equal(share.readTemplateSharePackageV2(p).subject,'employee')
 assert.throws(()=>share.readTemplateSharePackageV2(editV2(structuredClone(p),m=>{m.relations=[{kind:'role-skill',from:'lead',to:'helper'}]})),/relationship/,'应用只经 role-connection 关联')
})

test('work-template resources must be JSON declarations and errors name the offending resource',()=>{
 const p=team();editV2(p,m=>{m.resources.push(res('flow','work-template','work-templates/flow.md'))});setFile(p,'work-templates/flow.md','# Flow\n')
 assert.throws(()=>readAny(p),/work-template resource flow must use a JSON declaration file \(\.json\): work-templates\/flow\.md/)
})
test('missing package fields are named instead of a generic invalid-template error',()=>{
 const p=app();delete p.title
 assert.throws(()=>readAny(p),/Missing: title/)
})

test('全量模板校验错误点名资源 id、路径与缺失字段，供 页内新建 按原因修正',()=>{
 const missingFile=employee();dropFile(missingFile,'roles/lead.json')
 assert.throws(()=>readAny(missingFile),/resource file is missing: lead \(roles\/lead\.json\)/)
 const wrongType=editV2(employee(),m=>{m.resources[0].kind='bot'})
 assert.throws(()=>readAny(wrongType),/resource lead has an unsupported type: bot/)
 const reused=editV2(employee(),m=>{m.resources[1].source.path='roles/lead.json'})
 assert.throws(()=>readAny(reused),/resource file is reused: roles\/lead\.json \(resource review\)/)
 const plainText=editV2(employee(),m=>{m.resources[1].source.path='skills/review/data.json'})
 assert.throws(()=>readAny(setFile(plainText,'skills/review/data.json','{}')),/skill resource review must be plain text \(\.md\/\.txt\): skills\/review\/data\.json/)
 const relation=editV2(employee(),m=>{m.relations=[{kind:'role-skill',from:'lead',to:'absent'}]})
 assert.throws(()=>readAny(relation),/relationship is incomplete or invalid: role-skill lead -> absent/)
 const identity=editV2(employee(),m=>{m.id='other-id'})
 assert.throws(()=>readAny(identity),/identity or version differ: other-id@1\.0\.0 vs research-team@1\.0\.0/)
 const missingField=app();delete missingField.title
 assert.throws(()=>readAny(missingField),/Missing: title/)
 // v1 同一条：资源文件缺失也要点名资源与路径。
 const v1=changeManifest(sample(),v=>{v.resources[0].source.path='missing.json'})
 assert.throws(()=>readTemplateSharePackage(v1),/resource file is missing: employee \(missing\.json\)/)
})
