import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildSharePlan,readSharePackage,sharePackageDigest,sharePackageSummary,shareInspectionInput,readShareSubmission} from '../src/client/share-package-plan.ts'
import {buildEmployeeTemplate} from '../src/client/employee-template-share.ts'

const role=(id:string,name:string,skills:string[]=[])=>({id,name,kind:'employee' as const,duty:'Verify sources.',dataScope:'Provided documents.',executionScope:'Confirm external writes.',skills,knowledge:['private-knowledge-id'],scopes:['general'],runtimeConfig:{modelAccountId:'private-account'},responsibility:{triggers:[],autonomousActions:[],confirmationPoints:['Ask before external writes.'],escalationRules:[],deliveryChecks:[]}})
const base={publisher:'Max',license:'CC-BY-4.0',connections:[],plugins:[]}
const skillText='---\nname: research-notes\ndescription: Keep notes\n---\n# Research notes\nCollect sources.'

test('employee plan keeps real skill identity and license, excludes private knowledge, runtime and owner identity',async()=>{
 const pkg=buildSharePlan({...base,subject:'employee',roles:[role('owner-role-id','Researcher',['research-notes','untracked-skill'])],skills:[{name:'research-notes',title:'Research notes',resourceId:'research-notes',version:'1.2.0',text:skillText,license:'MIT',publisher:'Upstream Author',sourceUrl:'https://example.org/skills'}]})
 assert.equal(pkg.format,'teloa.template-share/v2');assert.equal(pkg.subject,'employee')
 const raw=JSON.stringify(pkg)
 for(const secret of ['owner-role-id','private-knowledge-id','private-account','modelAccountId','"scopes"'])assert.ok(!raw.includes(secret),secret+' must not leak')
 const manifest=JSON.parse(pkg.files.find(f=>f.path==='teloa.json')!.text)
 const skill=manifest.resources.find((r:{kind:string})=>r.kind==='skill')
 assert.equal(skill.id,'research-notes');assert.equal(skill.version,'1.2.0');assert.equal(skill.source.kind,'local')
 assert.ok(pkg.files.some(f=>f.path===skill.source.path&&f.text===skillText),'skill body travels with the package')
 assert.deepEqual(pkg.provenance.sources.map(s=>[s.license,s.resourceIds]),[['MIT',['research-notes']]])
 assert.ok(manifest.relations.some((r:{kind:string;to:string})=>r.kind==='role-skill'&&r.to==='research-notes'))
 assert.ok(pkg.requirements.some(r=>r.includes('untracked-skill')),'unresolved skill becomes a receiver requirement, not a fake resource')
 assert.ok(pkg.requirements.some(r=>/knowledge/i.test(r)))
 assert.equal(readSharePackage(pkg).id,pkg.id)
 assert.match(await sharePackageDigest(pkg),/^[a-f0-9]{64}$/)
})

test('public catalog skills are pinned by id and version instead of copying text',()=>{
 const pkg=buildSharePlan({...base,subject:'skill',roles:[],skills:[{name:'official-skill',title:'Official',resourceId:'official-skill',version:'2.0.0',publicId:'official-skill'}]})
 const manifest=JSON.parse(pkg.files.find(f=>f.path==='teloa.json')!.text)
 assert.deepEqual(manifest.resources[0].source,{kind:'public',id:'official-skill',version:'2.0.0'})
 assert.equal(pkg.files.length,2,'teloa.json and README only')
 assert.equal(sharePackageSummary(pkg).subject,'skill')
})

test('team plan declares the coordinator explicitly and keeps member connections',()=>{
 const pkg=buildSharePlan({...base,subject:'team',title:'Support team',roles:[role('a','Lead',['research-notes']),role('b','Agent')],coordinatorRoleId:'b',skills:[{name:'research-notes',title:'Research notes',resourceId:'research-notes',version:'1.0.0',text:skillText,license:'MIT'}],connections:[{serverName:'slack',title:'Slack',tools:['send_message']}],bindings:[{roleId:'b',connections:['slack']}]})
 const summary=sharePackageSummary(pkg)
 assert.equal(summary.subject,'team');assert.equal(summary.roles.length,2)
 assert.equal(summary.coordinatorResourceId,summary.roles.find(r=>r.name==='Agent')!.resourceId)
 assert.equal(pkg.team?.coordinatorResourceId,summary.coordinatorResourceId)
 assert.deepEqual(summary.connections.map(c=>c.serverName),['slack'])
 assert.ok(pkg.compatibility.capabilities.includes('connections'))
 assert.throws(()=>buildSharePlan({...base,subject:'team',roles:[role('a','Lead'),role('b','Agent')],coordinatorRoleId:'missing',skills:[]}),/coordinator/i)
 assert.throws(()=>buildSharePlan({...base,subject:'team',roles:[role('a','Only')],skills:[]}),/team/i)
})

test('twin identities and reserved publisher are refused',()=>{
 assert.throws(()=>buildSharePlan({...base,subject:'employee',roles:[{...role('t','Twin'),kind:'twin'}],skills:[]}),/twin/i)
 assert.throws(()=>buildSharePlan({...base,publisher:'Teloa 官方目录',subject:'employee',roles:[role('a','One')],skills:[]}),/publisher/i)
})

test('summary reads v1 employee packages and packages without any employee without dereferencing a role',()=>{
 const v1=buildEmployeeTemplate({...role('x','Legacy'),avatarKey:'security-analyst'})
 const legacy=sharePackageSummary(readSharePackage(v1))
 assert.equal(legacy.subject,'employee');assert.equal(legacy.roles[0]!.avatarKey,'security-analyst')
 const mcp=buildSharePlan({...base,subject:'mcp',roles:[],skills:[],connections:[{serverName:'notion',title:'Notion',tools:['search']}]})
 const summary=sharePackageSummary(mcp)
 assert.equal(summary.roles.length,0);assert.equal(summary.subject,'mcp');assert.deepEqual(summary.connections[0]!.tools,['search'])
 const app=buildSharePlan({...base,subject:'app',roles:[],skills:[{name:'s',title:'S',resourceId:'s',version:'1.0.0',text:skillText,license:'MIT'}],connections:[{serverName:'notion',title:'Notion',tools:['search']}]})
 assert.equal(sharePackageSummary(app).subject,'app')
})

test('inspection input covers every file and the purpose; a credential in a skill body is refused by the reader',()=>{
 const pkg=buildSharePlan({...base,subject:'employee',roles:[role('a','One')],skills:[]})
 const input=shareInspectionInput(pkg)
 assert.equal(input.files.length,pkg.files.length);assert.equal(input.purpose,pkg.description)
 const leaked={...pkg,files:pkg.files.map(f=>f.path==='README.md'?{...f,text:f.text+'\napi_key = "abcdefghijklmnop1234567890"'}:f)}
 assert.throws(()=>readSharePackage(leaked),/credential/i)
})

test('submission receipts use the shared state contract and reject unsupported fields and states',()=>{
 const input={shareId:'0f3c9d1e-5a7b-4c2d-8e9f-0a1b2c3d4e5f',sha256:'a'.repeat(64),state:'pending',submittedAt:'2026-10-14T00:00:00.000Z'},row=readShareSubmission(input)
 assert.equal(row.status,'pending');assert.equal(row.sha256,input.sha256)
 assert.equal(readShareSubmission({shareId:'0f3c9d1e-5a7b-4c2d-8e9f-0a1b2c3d4e5f',sha256:'a'.repeat(64),state:'approved',submittedAt:'2026-10-14T00:00:00.000Z'}).status,'approved')
 assert.throws(()=>readShareSubmission({...input,state:'live'}))
 assert.throws(()=>readShareSubmission({...input,status:'pending'}))
 assert.throws(()=>readShareSubmission({...input,ownerId:'private'}))
})
