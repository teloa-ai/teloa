import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializePageCreateDrafts,PageCreateDraftService,PageCreatePreviewService,type PageCreateActor} from '../src/index.ts'

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
