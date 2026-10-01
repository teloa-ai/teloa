import test from 'node:test'
import assert from 'node:assert/strict'
import type {CapabilitySnapshot,MarketPluginInstallObservation} from '@teloa/contract'
import type {MarketPluginInstallation} from '../src/client/market-plugin-install-api.ts'
import type {MarketSkillRuntimeFact} from '../src/client/market-runtime-state.ts'
import {loadWorkspaceCapabilitySearchDirectory,workspaceCapabilitySearchRows} from '../src/client/workspace-capability-search.ts'

const hash='a'.repeat(64),otherHash='b'.repeat(64)
const installedSkill:MarketSkillRuntimeFact={
 record:{id:'20000000-0000-4000-8000-000000000001',ownerId:'local:teloa-owner',source:{kind:'atomic',contentId:'10000000-0000-4000-8000-000000000001',contentHash:hash,resourceId:'incident-report',resourceVersion:'1.0.0'},bundleHash:hash,native:{name:'incident-report',description:'生成事件报告',modelInvocable:true,userInvocable:true,bodyHash:hash},state:'installed',version:1,createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:00:00.000Z'},
 availability:{installationId:'20000000-0000-4000-8000-000000000001',ownerId:'local:teloa-owner',availability:'enabled',version:1,updatedAt:'2026-09-14T00:00:00.000Z'},
 observation:{installationId:'20000000-0000-4000-8000-000000000001',scope:'default-workspace',state:'available',current:{name:'incident-report',description:'生成事件报告',modelInvocable:true,userInvocable:true,bodyHash:hash,provider:'teloa-market',source:'/fixed/incident-report'}},
}
const activePluginObservation={schema:'teloa.market-plugin-install-observation/v1',status:'active',source:{registry:'npm',packageName:'@teloa/visualize',version:'1.2.3'},bundleHash:hash,permissionSummary:{permissions:[]}} satisfies MarketPluginInstallObservation
const plugin:MarketPluginInstallation={id:'30000000-0000-4000-8000-000000000001',ownerId:'local:teloa-owner',preview:{schema:'teloa.market-plugin-install-preview/v1',source:{registry:'npm',packageName:'@teloa/visualize',version:'1.2.3'},trust:{status:'verified',publisher:'Teloa',integrity:'sha512-'+Buffer.from('integrity').toString('base64')},bundleHash:hash,permissionSummary:{permissions:[]}},state:'installed-active',attempt:1,receipt:{schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded'},observation:activePluginObservation,createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:00:00.000Z'}
const snapshot:CapabilitySnapshot={schema:'teloa.capabilities/v1',conversation:{id:'work-1',ownerId:'local:teloa-owner',title:'真实会话',scopeIds:['general'],version:1,status:'ready',requestedSessionId:'session-1',sessionId:'session-1',createdAt:'2026-09-14T00:00:00.000Z'},observedAt:'2026-09-14T00:00:01.000Z',skills:[],knowledge:{status:'not-connected'},connections:{status:'observed',tools:[{name:'mcp__security__query_alert',description:'读取告警'},{name:'mcp__security__isolate_host',description:'隔离终端'}]},writes:{status:'draft-only'}}

test('只投影经过真实运行观测的 Skill、插件和 MCP 工具，并保留稳定打开目标',()=>{
 const rows=workspaceCapabilitySearchRows({skills:[installedSkill],plugins:[plugin],snapshot})
 assert.deepEqual(rows.map(row=>[row.type,row.id,row.open]),[
  ['skill',installedSkill.record.id,{kind:'installation',id:'skill:'+installedSkill.record.id}],
  ['plugin',plugin.id,{kind:'installation',id:'plugin:'+plugin.id}],
  ['mcp','mcp__security__query_alert',{kind:'team-capability',category:'source',selectedId:'connection:mcp__security__query_alert'}],
  ['mcp','mcp__security__isolate_host',{kind:'team-capability',category:'source',selectedId:'connection:mcp__security__isolate_host'}],
 ])
 assert.equal(new Set(rows.map(row=>row.key)).size,rows.length)
})

test('排除准备、停用、缺失、遮蔽、核验失败和身份不一致的能力',()=>{
 const candidates:MarketSkillRuntimeFact[]=[
  {...installedSkill,record:{...installedSkill.record,id:'20000000-0000-4000-8000-000000000002',state:'preparing'}},
  {...installedSkill,availability:{...installedSkill.availability!,availability:'disabled'}},
  {...installedSkill,observation:{installationId:installedSkill.record.id,scope:'default-workspace',state:'missing',current:null}},
  {...installedSkill,observation:{...installedSkill.observation!,state:'shadowed',reason:'different-source'}},
  {...installedSkill,verificationError:true},
  {...installedSkill,observation:{...installedSkill.observation!,installationId:'20000000-0000-4000-8000-000000000099'}},
  {...installedSkill,observation:{...installedSkill.observation!,current:{...installedSkill.observation!.current!,bodyHash:otherHash}}},
 ]
 const {observation:_activeObservation,...pluginWithoutObservation}=plugin
 const plugins:MarketPluginInstallation[]=[
  {...plugin,id:'30000000-0000-4000-8000-000000000002',state:'installed-restart-required',observation:{...activePluginObservation,status:'restart-required'}},
  {...pluginWithoutObservation,id:'30000000-0000-4000-8000-000000000003',state:'failed'},
  {...plugin,id:'30000000-0000-4000-8000-000000000004',observation:{...activePluginObservation,bundleHash:otherHash}},
 ]
 assert.deepEqual(workspaceCapabilitySearchRows({skills:candidates,plugins}),[])
})

test('连接未观察、会话非就绪或重复工具不会伪造可用结果',()=>{
 assert.deepEqual(workspaceCapabilitySearchRows({skills:[],plugins:[],snapshot:{...snapshot,connections:{status:'not-connected'}}}),[])
 assert.deepEqual(workspaceCapabilitySearchRows({skills:[],plugins:[],snapshot:{...snapshot,conversation:{...snapshot.conversation,status:'pending'}}}),[])
 assert.equal(snapshot.connections.status,'observed')
 if(snapshot.connections.status!=='observed')return
 const first=snapshot.connections.tools[0]!
 assert.deepEqual(workspaceCapabilitySearchRows({skills:[],plugins:[],snapshot:{...snapshot,connections:{status:'observed',tools:[first,first]}}}).map(row=>row.id),['mcp__security__query_alert'])
})

test('目录读取逐条核验真实 Skill，并在单一来源失败时保留其它可用能力',async()=>{
 const calls:string[]=[]
 const loaded=await loadWorkspaceCapabilitySearchDirectory({
  skillInstallApi:{list:async()=>{calls.push('skill:list');return {items:[installedSkill.record],usages:[]}},observe:async id=>{calls.push('skill:observe:'+id);return installedSkill.observation!}},
  skillAvailabilityApi:{get:async id=>{calls.push('skill:availability:'+id);return installedSkill.availability!}},
  pluginInstallApi:{list:async()=>{calls.push('plugin:list');return {items:[plugin]}}},
  snapshot,
 })
 assert.deepEqual(calls,['skill:list','plugin:list','skill:availability:'+installedSkill.record.id,'skill:observe:'+installedSkill.record.id])
 assert.deepEqual(loaded.failures,[])
 assert.deepEqual(loaded.rows.map(row=>row.type),['skill','plugin','mcp','mcp'])

 const partial=await loadWorkspaceCapabilitySearchDirectory({
  skillInstallApi:{list:async()=>{throw Error('offline')},observe:async()=>{throw Error('unused')}},
  skillAvailabilityApi:{get:async()=>{throw Error('unused')}},
  pluginInstallApi:{list:async()=>({items:[plugin]})},snapshot,
 })
 assert.deepEqual(partial.failures,['skill'])
 assert.deepEqual(partial.rows.map(row=>row.type),['plugin','mcp','mcp'])
})
