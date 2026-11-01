import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializePageCreateDrafts,PageCreateDraftService,PageCreatePreviewService,type PageCreateActor} from '../src/index.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializePageCreateDrafts(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const actor=():PageCreateActor=>({ownerId:'local:'+randomUUID(),scopeIds:['SOC']})
const role=(name='核对同事')=>({name,kind:'employee',scopes:['SOC'],duty:'核对资料',dataScope:'本人授权资料',executionScope:'只提出建议',skills:[],knowledge:[],responsibility:{triggers:['每天'],autonomousActions:['整理资料'],confirmationPoints:['发出前'],escalationRules:['资料不足'],deliveryChecks:['逐项核对']}})
const service=()=>{const drafts=new PageCreateDraftService(pool,identity);return {drafts,preview:new PageCreatePreviewService(pool,identity,drafts)}}
const businessDomainBody=(scope:string)=>({
 manifest:{format:'teloa.business-package/v2',id:'recruiting-template',title:'招聘行业模板',version:'1.0.0',domain:'recruiting',scope,description:'用于验证新业务范围预览与落定。',resources:[{id:'recruiting-template-work',kind:'work-template',title:'招聘工作模板',version:'1.0.0',required:true,source:{kind:'local',path:'work-template.json'}}],relations:[],entrypoints:[]},
 definitions:[{format:'teloa.business-view/v1',id:'candidate-pipeline',version:'1.0.0',domain:'recruiting',title:'候选人漏斗',kind:'distribution',chart:'bar',objectType:'candidate',dimension:{field:'stage',limit:3},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3}],
})

test('岗位草案预览给出三块并且不写入草案',async()=>{
 const owner=actor(),{drafts,preview}=service(),draft=await drafts.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 const result=await preview.preview(owner,{draftId:draft.id})
 assert.equal(result.draft.id,draft.id)
 assert.ok(result.fields.some(field=>field.path==='name'&&field.value==='"核对同事"'))
 assert.deepEqual(result.consequences,[{kind:'impact',id:'role-onboarding',required:true}])
 assert.deepEqual(result.next,{endpoint:'roles/create',consentKeys:[]})
 const after=(await drafts.directory(owner,{entity:'role'})).drafts.find(item=>item.id===draft.id)
 assert.equal(after?.updatedAt,draft.updatedAt)
})

test('员工预览只投影当前本人及岗位范围内的资料名，撤权撤回不复用旧名且不读正文',async()=>{
 await initializeResources(pool)
 let bodyReads=0
 const resources=new ResourceService(pool,{list:async()=>{throw Error('不得读取来源目录')},read:async()=>{bodyReads++;return {text:'仅用于建立隔离资料'} as never}},identity)
 const owner=actor(),human={...owner,kind:'human' as const,scopeIds:['general','SOC','HR']}
 const make=async(ownerId:string,title:string,scope:string)=>{const draft=await resources.create({...human,ownerId},{requestId:randomUUID(),title,sourceId:'test-source',sourceVersion:'a'.repeat(64),scopeIds:[scope]});return resources.apply({...human,ownerId},{draftId:draft.id,expectedVersion:draft.version})}
 const allowed=await make(owner.ownerId,'订单核对规范','SOC'),otherScope=await make(owner.ownerId,'不可显示的人事名称','HR'),foreign=await make('local:'+randomUUID(),'不可显示的他人名称','SOC')
 const {drafts}=service(),body={...role(),skills:['订单核验','未核验技能标识'],knowledge:[allowed.id,otherScope.id,foreign.id,randomUUID()]}
 const draft=await drafts.draft(owner,{entity:'role',body,requestId:randomUUID()})
 const references={knowledge:async(current:PageCreateActor)=>(await resources.list({...current,kind:'human',scopeIds:['general',...current.scopeIds]})).resources,skills:async()=>[{name:'订单核验'}]}
 const preview=new PageCreatePreviewService(pool,identity,drafts,undefined,undefined,{},references)
 const reads=bodyReads,first=await preview.preview({...owner,scopeIds:['SOC','HR']},{draftId:draft.id})
 assert.deepEqual(first.roleReferences,{knowledge:['订单核对规范',null,null,null],skills:['订单核验',null]})
 assert.equal(first.draft.body,draft.body);assert.equal(first.draft.bodyHash,draft.bodyHash)
 assert.deepEqual((await preview.preview({...owner,scopeIds:[]},{draftId:draft.id})).roleReferences?.knowledge,[null,null,null,null],'失去本人范围后不能回用先前名称')
 await resources.withdraw(human,{resourceId:allowed.id,expectedVersion:allowed.version})
 assert.deepEqual((await preview.preview(owner,{draftId:draft.id})).roleReferences?.knowledge,[null,null,null,null],'撤回后重新预览不能复用名称')
 assert.equal(bodyReads,reads,'展示名称不得读取资料正文')
 assert.equal((await drafts.read(owner,{draftId:draft.id})).bodyHash,draft.bodyHash)
 assert.deepEqual((await new PageCreatePreviewService(pool,identity,drafts).preview(owner,{draftId:draft.id})).roleReferences,{knowledge:[null,null,null,null],skills:[null,null]},'未接入目录不猜测名称')
 const failed=new PageCreatePreviewService(pool,identity,drafts,undefined,undefined,{}, {...references,knowledge:async()=>{throw Error('目录读取失败')}})
 await assert.rejects(failed.preview(owner,{draftId:draft.id}),/目录读取失败/,'读取失败保持预览失败，不能伪装成已核验')
})

test('连接器预览明确提示凭据和外发；落定草案不得再预览',async()=>{
 const owner=actor(),{drafts,preview}=service()
 const body={manifest:{format:'teloa.business-package/v2',id:'soc-connector',title:'SOC 连接',version:'1.0.0',domain:'SOC',description:'用于验证连接器预览。',resources:[{id:'alert-data',kind:'data-source',title:'告警源',version:'1.0.0',required:true,source:{kind:'local',path:'data/alerts.json'}}],relations:[],entrypoints:[]},resource:{format:'teloa.data-source/v1',sourceId:'soc-alert',scopes:['SOC']}}
 const draft=await drafts.draft(owner,{entity:'connector',scope:'SOC',body,requestId:randomUUID()})
 const result=await preview.preview(owner,{draftId:draft.id})
 assert.deepEqual(result.consequences,[{kind:'credential',id:'credential',required:true},{kind:'egress',id:'soc-alert',required:true}])
 assert.deepEqual(result.next.consentKeys,['create.consequence.credential','create.consequence.egress'])
 await drafts.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'discarded'})
 await assert.rejects(()=>preview.preview(owner,{draftId:draft.id}),{code:'teloa/conflict'})
})

test('新业务范围未登记时，草案预览与落定仍能完成',async()=>{
 const owner=actor(),{drafts,preview}=service()
 const draft=await drafts.draft(owner,{entity:'business-domain',scope:'recruiting',body:businessDomainBody('recruiting'),requestId:randomUUID()})
 const result=await preview.preview(owner,{draftId:draft.id})
 assert.equal(result.draft.id,draft.id)
 assert.deepEqual(result.next,{endpoint:'market-content/import-industry',consentKeys:[]})
 const directory=await drafts.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'applied',appliedRef:'industry-load-1'})
 assert.equal(directory.drafts.find(item=>item.id===draft.id)?.status,'applied')
})

test('业务声明不在缺少必要预览端口时伪造半份预览；产品底座只用官方插件，白名单已清空的扩展在草案创建阶段就一律拒绝',async()=>{
 const owner=actor(),{drafts,preview}=service()
 const definition={format:'teloa.business-view/v1',id:'severity-distribution',version:'1.0.0',domain:'SOC',title:'风险分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',dimension:{field:'severity',limit:3},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3}
 const business=await drafts.draft(owner,{entity:'business-definition',scope:'SOC',body:definition,requestId:randomUUID()})
 // officialExtensionPackages 为空：形状合法的官方包引用也在 draft() 内部就被 readPageCreateBody 拒绝，
 // 走不到「缺预览端口」这一步——第三方插件 dsh-visualize 已整体下线，不再有任何包能通过白名单。
 await assert.rejects(()=>drafts.draft(owner,{entity:'extension',body:{registry:'npm',packageName:'dsh-visualize',version:'0.1.2'},requestId:randomUUID()}),{code:'teloa/invalid-input'})
 await assert.rejects(()=>preview.preview(owner,{draftId:business.id}),{code:'teloa/dependency-unavailable'})
 await assert.rejects(()=>preview.preview({...owner,ownerId:'local:'+randomUUID()},{draftId:business.id}),{code:'teloa/forbidden'})
})
