import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
const module=await import('../src/client/business-work-results-api.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/client/business-work-results-api.ts');throw e})
test('采用按钮只取得原生意图；回包身份变化不能跳转或发送，拒绝操作绑定版本',async()=>{
 assert.equal(typeof module.createBusinessWorkResultsApi,'function')
 const id=randomUUID(),calls:unknown[]=[],sent:string[]=[];let sessionId='original-session'
 const api=module.createBusinessWorkResultsApi(async(endpoint,input)=>{calls.push({endpoint,input});return {sessionId,text:'请求原生审批'}},{resume:async id=>sent.push(id),send:async(_id,text)=>sent.push(text)})
 const input={changeSetId:id,expectedRevision:1,expectedDigest:'a'.repeat(64)}
 await api.requestApply(input,'original-session');assert.deepEqual(sent,['original-session','请求原生审批'])
 assert.equal((calls[0] as any).endpoint,'business-changes/intent')
 sessionId='foreign-session';await assert.rejects(api.requestApply(input,'original-session'));assert.equal(sent.length,2)
 await assert.rejects(api.requestApply({...input,approved:true},'original-session'));assert.equal(calls.length,2)
})
test('对象工作列表只发送对象身份，详情快照版本和摘要不混入列表协议',async()=>{
 const requests:unknown[]=[],api=module.createBusinessWorkResultsApi(async(_endpoint,input)=>{requests.push(input);return {items:[],taskResults:[]}})
 await api.list({scope:'sales',type:'customer',id:'one',version:1,snapshotHash:'a'.repeat(64)} as any)
 assert.deepEqual(requests,[{scope:'sales',type:'customer',id:'one'}])
})
test('工作关联回包丢失后重建页面沿原会话和原请求恢复，不重复创建工作',async()=>{
 const reference={scope:'sales',type:'customer',id:'one',version:1,snapshotHash:'a'.repeat(64)},saved=new Map<string,string>(),requests:unknown[]=[];let starts=0,fail=true
 const navigation={namespace:'verified-owner-space',storage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value)},removeItem:(key:string)=>{saved.delete(key)}},start:async()=>{starts++;return 'original-session'},resume:async()=>{},send:async()=>{}}
 const call=async(endpoint:string,input:any)=>{assert.equal(endpoint,'business-work/link');requests.push(input);if(fail){fail=false;throw Error('回包丢失')}return {id:randomUUID(),reference,sessionId:'original-session',title:'研究客户',createdAt:new Date().toISOString()}}
 const first=module.createBusinessWorkResultsApi(call,navigation)
 await assert.rejects(first.startWork(reference,'研究客户'))
 const rebuilt=module.createBusinessWorkResultsApi(call,navigation)
 await rebuilt.startWork(reference,'研究客户');assert.equal(starts,1);assert.deepEqual(requests[0],requests[1]);assert.equal(saved.size,0)
})
