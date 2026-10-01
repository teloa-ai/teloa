import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'
import {readSkillInstallDirectory,type SkillInstallDirectoryPorts} from '../src/skill-install-directory.ts'

const a='12345678-1234-4234-8234-123456789012',b='22345678-1234-4234-8234-123456789012',c='32345678-1234-4234-8234-123456789012',d='42345678-1234-4234-8234-123456789012'
const atomic=(id:string,title:string)=>({id,ownerId:'owner',kind:'atomic-skill',logicalId:title.toLowerCase(),version:'1.0.0',hash:'a'.repeat(64),baseHash:'b'.repeat(64),manifestPath:'SKILL.md',metadata:{id:title.toLowerCase(),title,version:'1.0.0',categories:[]},provides:[{resourceId:title.toLowerCase(),kind:'skill',version:'1.0.0',path:'SKILL.md'}],references:[],createdAt:'2026-09-12T00:00:00.000Z'})
const load={id:b,ownerId:'owner',contentId:b,contentHash:'c'.repeat(64),templateId:'security',templateVersion:'1.0.0',templateTitle:'安全',domain:'security',description:'行业',targetVersion:1,space:{id:c,name:'安全空间',version:1,scope:'space-'+c},items:[{localId:'method',instanceId:d,kind:'skill',title:'处置方法',version:'1.2.0',required:true,status:'pending-adapter'},{localId:'role',instanceId:a,kind:'role',title:'岗位',version:'1.0.0',required:true,status:'pending-adapter'},{localId:'skipped',instanceId:c,kind:'skill',title:'跳过',version:'1.0.0',required:false,status:'skipped'}],relations:[],entrypoints:[d],createdAt:'2026-09-12T00:00:00.000Z'}
const installation={id:a,ownerId:'owner',source:{kind:'atomic',contentId:a,contentHash:'a'.repeat(64),resourceId:'other',resourceVersion:'1.0.0'},bundleHash:'d'.repeat(64),native:{name:'same-name',description:'说明',modelInvocable:true,userInvocable:true,bodyHash:'e'.repeat(64)},state:'installed',version:1,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}

function ports(overrides:Partial<SkillInstallDirectoryPorts>={}):SkillInstallDirectoryPorts{
 return {
  owner:'owner',
  marketContentHandler:async(_method,payload)=>'cursor' in payload?{items:[atomic(b,'Second')],nextCursor:null}:{items:[atomic(a,'First'),{...atomic(c,'Package'),kind:'industry-template'}],nextCursor:b},
  industryLoadsHandler:async()=>({items:[load]}),
  skillInstallationsHandler:async()=>({items:[installation],usages:[]}),
  ...overrides,
 }
}

test('聚合完整原子来源、待适配行业 Skill、真实安装与 usage，不猜同名关联',async()=>{
 const calls:string[]=[]
 const base=ports(),result=await readSkillInstallDirectory({
  owner:'owner',
  marketContentHandler:async(method,payload)=>{calls.push(method+':'+JSON.stringify(payload));return base.marketContentHandler(method,payload)},
  industryLoadsHandler:async(method,payload)=>{calls.push(method+':'+JSON.stringify(payload));return base.industryLoadsHandler(method,payload)},
  skillInstallationsHandler:async(method,payload)=>{calls.push(method+':'+JSON.stringify(payload));return {items:[installation],usages:[{loadId:b,itemInstanceId:d,installationId:a}]}},
 })
 assert.deepEqual(result.atomic,[
  {source:{kind:'atomic',contentId:a},title:'First',version:'1.0.0'},
  {source:{kind:'atomic',contentId:b},title:'Second',version:'1.0.0'},
 ])
 assert.deepEqual(result.industry,[{source:{kind:'industry',loadId:b,itemInstanceId:d},title:'处置方法',version:'1.2.0',space:{id:c,name:'安全空间'}}])
 assert.deepEqual(result.installations,[installation])
 assert.deepEqual(result.usages,[{loadId:b,itemInstanceId:d,installationId:a}])
 assert.deepEqual(calls,[
  'market-content/list:{"limit":100}',
  'industry-loads/list:{}',
  'skill-installations/list:{}',
  `market-content/list:{"limit":100,"cursor":"${b}"}`,
 ])
 assert.equal('installationId' in result.industry[0]!,false)
})

test('坏聚合回包显式失败，游标循环不静默截断',async()=>{
 for(const replacement of [
  {marketContentHandler:async()=>({items:'bad',nextCursor:null})},
  {industryLoadsHandler:async()=>({items:[{...load,ownerId:'other'}]})},
  {skillInstallationsHandler:async()=>({items:[],usages:'bad'})},
  {marketContentHandler:async()=>({items:[],nextCursor:a})},
 ])await assert.rejects(readSkillInstallDirectory(ports(replacement as Partial<SkillInstallDirectoryPorts>)),{code:'teloa/invalid-host-response'})
})

test('底层明确错误原样保留且不调用 preview 或文件入口',async()=>{
 const failure=new WorkError('teloa/storage-corrupt','固定目录损坏')
 await assert.rejects(readSkillInstallDirectory(ports({industryLoadsHandler:async()=>{throw failure}})),error=>error===failure)
})
