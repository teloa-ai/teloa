import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createJournalStorage} from '../src/client/journal-storage.ts'
import {createSecurityActionApi,securityActionCommands} from '../src/client/security-action-api.ts'
import {action,panel,execution,command,taskId,owner,requestId,source} from './security-action-fixtures.ts'

const context={panel,taskVersion:1,source}

/** 同源 localStorage 的最小替身：两个"标签页"共用同一份 data 就等于共用同一个浏览器域。 */
function sharedStorage(){
 const data=new Map<string,string>()
 return {data,area:{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}}
}
const journalsOf=(area:ReturnType<typeof sharedStorage>['area'])=>Object.fromEntries(securityActionCommands.map(kind=>[kind,createJournalStorage('teloa.security-action.'+kind+'/v1',area)]))

test('未决请求日志的存储层同源共享：一个标签页写下的记录，另一个标签页读得到',()=>{
 const {area}=sharedStorage()
 const tabA=createJournalStorage('teloa.task-create/v1',area),tabB=createJournalStorage('teloa.task-create/v1',area)
 assert.equal(tabB.read(),null)
 tabA.write('{"schema":"teloa.task-create/v1"}')
 assert.equal(tabB.read(),'{"schema":"teloa.task-create/v1"}','关掉 A 再开 B 也必须还看得到这条未决请求（已知边界 1）')
 tabB.clear()
 assert.equal(tabA.read(),null,'任一标签页丢弃之后两边一起干净，不留两份互相矛盾的 requestId')
})

test('存储缺席（受限浏览器）时读写不抛，只是没有恢复记录',()=>{
 const journal=createJournalStorage('teloa.task-create/v1',undefined)
 assert.equal(journal.read(),null)
 journal.write('x');journal.clear()
 assert.equal(journal.read(),null)
})

test('键名必须是既有的 teloa.<业务>/v<n> 形状，不许顺手开新键',()=>{
 const {area}=sharedStorage()
 for(const key of ['teloa.task-create','task-create/v1','teloa.Task-Create/v1','teloa.task-create/v1 ',''])assert.throws(()=>createJournalStorage(key,area),/键名/,key+' 应被拒绝')
 assert.doesNotThrow(()=>createJournalStorage('teloa.security-action.withdraw-approval/v1',area))
})

test('宿主接线：未决请求日志一条都不再挂在 sessionStorage 上',async()=>{
 const source=await readFile(new URL('../src/client/index.ts',import.meta.url),'utf8')
 assert.ok(source.includes('createJournalStorage'),'日志存储必须统一走 journal-storage.ts，键名与存储层才有一处可核对')
 const strays=source.split('\n').filter(line=>!line.trimStart().startsWith('//')&&line.includes('sessionStorage')&&!line.includes('WorkbenchNavigation')&&!line.includes('storage:sessionStorage')&&!line.includes('sessionStorage.getItem(key)')&&!line.includes('sessionStorage.setItem(key,workspaceId)'))
 // 导航、待用空白会话与其执行位置是标签页状态；业务设置和原生发送未决日志必须跨标签页保存。
 assert.deepEqual(strays,[],'sessionStorage 是标签页私有的，关掉标签页就丢 journal（已知边界 1）')
 assert.match(source,/createHomeContextApi\(call,localStorage\)/)
 assert.match(source,/new HomeSubmissionJournal\(localStorage,sessionId\)/)
 assert.ok(!/sessionStorage\.(get|set|remove)Item\('teloa\./.test(source),'任何 teloa.<业务>/v1 键都不许再直接挂 sessionStorage')
})

test('安全动作 journal 跨标签页一致：另一个标签页写下的未决请求，本标签页当场读得到',async()=>{
 const {area}=sharedStorage()
 // B 先建起来（此刻存储是空的），随后 A 才写下未决请求——构造期快照读不到，只有每次重读才读得到。
 const tabB=createSecurityActionApi(async()=>execution,journalsOf(area),owner)
 assert.equal(tabB.pending('execute'),undefined)
 const tabA=createSecurityActionApi(async()=>{throw new DOMException('cancel','AbortError')},journalsOf(area),owner)
 await assert.rejects(tabA.execute(command,context),{name:'AbortError'})
 assert.equal(tabB.pending('execute')?.request.requestId,requestId,'两个标签页必须认同一个 requestId，否则重放会造出第二条请求')
})

test('一个标签页把未决请求核对干净之后，另一个标签页不再显示待恢复',async()=>{
 const {area}=sharedStorage()
 const tabA=createSecurityActionApi(async()=>{throw new DOMException('cancel','AbortError')},journalsOf(area),owner)
 await assert.rejects(tabA.execute(command,context),{name:'AbortError'})
 const tabB=createSecurityActionApi(async()=>({...execution,revision:3}),journalsOf(area),owner)
 assert.equal((await tabB.recover('execute')).revision,3)
 assert.equal(tabA.pending('execute'),undefined,'B 核对完成清掉了记录，A 不该继续把这条任务的写入锁着')
})

test('另一个标签页写坏记录后本标签页报读坏；任一边丢弃两边一起清空',async()=>{
 const {area}=sharedStorage()
 const tabA=createSecurityActionApi(async()=>execution,journalsOf(area),owner)
 assert.equal(tabA.recoveryError('execute'),undefined)
 area.setItem('teloa.security-action.execute/v1','{broken')
 assert.equal(tabA.recoveryError('execute')?.code,'teloa/storage-corrupt')
 const tabB=createSecurityActionApi(async()=>execution,journalsOf(area),owner)
 assert.equal(tabB.discardRecovery('execute'),true)
 assert.equal(tabA.recoveryError('execute'),undefined,'B 丢弃之后 A 不该还挂着同一条坏记录')
})

test('重读不打断在途请求：发送期间存储被改也用本次自己的请求体收尾',async()=>{
 const {area}=sharedStorage()
 let release=()=>{}
 const gate=new Promise<void>(resolve=>{release=resolve})
 const sent:unknown[]=[]
 const tab=createSecurityActionApi(async(_endpoint,value)=>{sent.push(value);await gate;return execution},journalsOf(area),owner)
 const sending=tab.execute(command,context)
 await Promise.resolve()
 area.setItem('teloa.security-action.execute/v1','{broken')
 release()
 assert.equal((await sending).operationId,execution.operationId,'在途请求不能被另一个标签页的写入掀翻')
 assert.deepEqual(sent,[command])
 void action;void taskId
})
