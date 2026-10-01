import test from 'node:test'
import assert from 'node:assert/strict'
import {readdir,readFile} from 'node:fs/promises'
import {createRecoveryGate} from '../src/client/recovery-error.ts'
import {createIndustryPluginApi} from '../src/client/industry-plugin-api.ts'
import {createMarketPluginInstallApi} from '../src/client/market-plugin-install-api.ts'
import {createBusinessTaskApi} from '../src/client/business-task-api.ts'
import {createSecurityActionApi,securityActionCommands} from '../src/client/security-action-api.ts'
import {createGithubSourceApi} from '../src/client/github-source-api.ts'
import {createGroupApi} from '../src/client/group-api.ts'
import {createIndustryDataSourceApi} from '../src/client/industry-data-source-api.ts'
import {createIndustryExecutionToolApi} from '../src/client/industry-execution-tool-api.ts'
import {createIndustryKnowledgeApi} from '../src/client/industry-knowledge-api.ts'
import {createIndustryLoadApi} from '../src/client/industry-load-api.ts'
import {createIndustryMcpConnectionApi} from '../src/client/industry-mcp-connection-api.ts'
import {createIndustryRoleApi} from '../src/client/industry-role-api.ts'
import {createIndustryTaskApi} from '../src/client/industry-task-api.ts'
import {createMarketContentApi} from '../src/client/market-content-api.ts'
import {createPlanApi} from '../src/client/plan-api.ts'
import {createSkillAvailabilityApi} from '../src/client/skill-availability-api.ts'
import {createSkillInstallApi} from '../src/client/skill-install-api.ts'
import {createTaskMaterialApi} from '../src/client/task-material-api.ts'
import {createIndustryPlanApi} from '../src/client/industry-plan-api.ts'
import {createObjectConversationApi} from '../src/client/object-conversation-api.ts'
import {createRoleMemoryApi} from '../src/client/role-memory-api.ts'
import {createRoleToolGrantApi} from '../src/client/role-tool-grant-api.ts'
import {createSkillUpgradeApi} from '../src/client/skill-upgrade-api.ts'

// M-3：这 22 个模块的恢复错误过去是纯字符串，喂给 localizeWorkError 的渲染处会回落成
// 通用文案或（直接渲染 recoveryMessage() 的两处）硬吐中文。统一收进 createRecoveryGate
// 背后的 recoveryStorageError()：读坏一律是 WorkError，code 固定为 teloa/storage-corrupt。
const M3_RECOVERY_API_FACTORIES:ReadonlyArray<(call:unknown,journal:unknown)=>{recoveryMessage:()=>{code?:unknown}|undefined;discard:()=>boolean}>=[
 createBusinessTaskApi,createGithubSourceApi,createGroupApi,createIndustryDataSourceApi,createIndustryExecutionToolApi,
 createIndustryKnowledgeApi,createIndustryLoadApi,createIndustryMcpConnectionApi,createIndustryPluginApi,createIndustryRoleApi,
 createIndustryTaskApi,createMarketContentApi,createMarketPluginInstallApi,createPlanApi,createSkillAvailabilityApi,
 createSkillInstallApi,createTaskMaterialApi,
] as never

const forbidden=async()=>{throw Error('丢弃恢复记录时不应调用服务端')}
const journalOf=(value:string|null)=>{let raw=value;return {read:()=>raw,write:(next:string)=>{raw=next},clear:()=>{raw=null},peek:()=>raw}}

test('读闸读坏时保留原记录并暴露稳定错误码',()=>{
 const journal=journalOf('{broken')
 const gate=createRecoveryGate(journal,raw=>JSON.parse(raw) as {a:number},1000)
 assert.equal(gate.recoveryMessage()?.code,'teloa/storage-corrupt')
 assert.equal(gate.pending(),undefined)
 assert.equal(journal.peek(),'{broken','读坏不静默清掉：用户还需要知道发生过什么')
})

test('超过字符上限同样按读坏处理',()=>{
 const gate=createRecoveryGate(journalOf('"'+'x'.repeat(50)+'"'),raw=>JSON.parse(raw) as string,10)
 assert.equal(gate.recoveryMessage()?.code,'teloa/storage-corrupt')
})

test('丢弃清掉本地记录与错误，并返回是否真的清掉了东西',()=>{
 const journal=journalOf('{broken')
 const gate=createRecoveryGate(journal,raw=>JSON.parse(raw) as {a:number},1000)
 assert.equal(gate.discard(),true)
 assert.equal(journal.peek(),null)
 assert.equal(gate.recoveryMessage(),undefined)
 assert.equal(gate.discard(),false,'已经没有记录时返回 false')
})

test('存储坏到清不掉时丢弃仍然成功，不把用户堵在同一处',()=>{
 const gate=createRecoveryGate({read:()=>'{broken',write:()=>{},clear:()=>{throw Error('storage full')}},raw=>JSON.parse(raw) as unknown,1000)
 assert.equal(gate.discard(),true)
 assert.equal(gate.recoveryMessage(),undefined)
})

test('行业插件安装的坏记录可丢弃，丢弃后不调用服务端且可重新发起',async()=>{
 const journal=journalOf('{broken')
 const api=createIndustryPluginApi(forbidden,journal)
 assert.equal(api.recoveryMessage()?.code,'teloa/storage-corrupt')
 assert.equal(api.discard(),true)
 assert.equal(api.recoveryMessage(),undefined)
 assert.equal(journal.peek(),null)
})

test('M-3：第一批 17 个恢复入口的坏记录一律是 WorkError，code 固定 teloa/storage-corrupt，且都能丢弃（不再是纯字符串）',()=>{
 for(const create of M3_RECOVERY_API_FACTORIES){
  const journal=journalOf('{broken')
  const api=create(forbidden,journal)
  const error=api.recoveryMessage()
  assert.equal(error?.code,'teloa/storage-corrupt',create.name+' 的恢复错误 code 不是 teloa/storage-corrupt')
  assert.equal(api.discard(),true,create.name+' 丢弃应返回 true')
  assert.equal(api.recoveryMessage(),undefined,create.name+' 丢弃后应清空恢复错误')
 }
})

test('M-3：剩余五个恢复入口同样用稳定 WorkError 表达损坏记录',()=>{
 const broken=()=>journalOf('{broken')
 const apis=[
  createIndustryPlanApi(forbidden,broken(),value=>value as never),
  createObjectConversationApi(forbidden,broken()),
  createRoleMemoryApi(forbidden,broken()),
  createRoleToolGrantApi(forbidden,broken()),
  createSkillUpgradeApi(forbidden,broken()),
 ]
 for(const api of apis){
  assert.equal(api.recoveryMessage()?.code,'teloa/storage-corrupt')
  assert.equal(api.discard(),true)
  assert.equal(api.recoveryMessage(),undefined)
 }
})

test('安全动作的丢弃按命令分本，丢一条不影响其他命令',()=>{
 const journals=Object.fromEntries(securityActionCommands.map(kind=>[kind,journalOf(kind==='decide'||kind==='execute'?'{broken':null)]))
 const api=createSecurityActionApi(forbidden,journals as never)
 assert.ok(api.recoveryError('decide'));assert.ok(api.recoveryError('execute'))
 assert.equal(api.discardRecovery('decide'),true)
 assert.equal(api.recoveryError('decide'),undefined)
 assert.ok(api.recoveryError('execute'),'另一条命令的坏记录不受影响')
 assert.equal(api.discardRecovery('propose'),false,'没有记录的命令返回 false')
})

test('全部暴露恢复错误的客户端接口都提供丢弃入口',async()=>{
 const dir=new URL('../src/client/',import.meta.url)
 const missing:string[]=[]
 for(const name of (await readdir(dir)).filter(file=>file.endsWith('.ts'))){
  const text=await readFile(new URL(name,dir),'utf8')
  if(!/recoveryMessage\s*:/.test(text))continue
  if(!/\bdiscard\w*\s*[:(]/.test(text))missing.push(name)
 }
 assert.deepEqual(missing,[],'这些模块暴露了恢复错误却没有出路')
})

test('全部渲染恢复错误的组件都是丢弃按钮 + 下一步提示 + 已丢弃确认三件套',async()=>{
 const dir=new URL('../src/client/',import.meta.url)
 // 丢弃按钮只能出现在真正持有 api 引用（能调用 .discard()）的组件自己身上；
 // 但错误文字与"下一步"提示、"已丢弃"确认可能被下放到它实际委托渲染错误的那个子组件里。
 // 这里按"父组件 -> 它委托的子组件"精确配对，不做全局池子——否则某个父组件的判据
 // 会被另一个父组件完全无关的子组件顺带满足，判据形同虚设。
 const delegates:Record<string,readonly string[]>={
  'SkillInstallControl.tsx':['SkillInstallationStatus.tsx'],
  'WorkbenchFrame.tsx':['ObjectConversations.tsx'],
  'MarketPage.tsx':['IndustryLoadForm.tsx'],
 }
 const delegateText=Object.fromEntries(await Promise.all(Object.entries(delegates).map(async([name,files])=>[name,(await Promise.all(files.map(file=>readFile(new URL(file,dir),'utf8')))).join('\n')])))
 const missing:string[]=[]
 for(const name of (await readdir(dir)).filter(file=>file.endsWith('.tsx'))){
  const text=await readFile(new URL(name,dir),'utf8')
  if(!/recoveryMessage\(\)|recoveryError\(/.test(text))continue
  const withDelegates=text+'\n'+(delegateText[name]??'')
  if(!text.includes("'recovery.discard'"))missing.push(name+' 缺 recovery.discard')
  if(!withDelegates.includes("'recovery.nextStep'"))missing.push(name+' 缺 recovery.nextStep')
  if(!withDelegates.includes("'recovery.discarded'"))missing.push(name+' 缺 recovery.discarded')
 }
 assert.deepEqual(missing,[])
})
