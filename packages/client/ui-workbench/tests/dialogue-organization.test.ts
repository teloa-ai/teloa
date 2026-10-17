import assert from 'node:assert/strict'
import test from 'node:test'
import {createDialogueOrganization,dialogueEntryKey} from '../src/client/dialogue-organization.ts'

const storage=()=>{const rows=new Map<string,string>();return {rows,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)}}}
test('助手命名、目录类型和分组重载保留；组织入口不改变原会话或群身份',()=>{
 const memory=storage(),store=createDialogueOrganization(memory)
 assert.equal(store.getSnapshot().assistantName,'Teloa');store.renameAssistant(' 松果 ')
 const folder=store.createFolder('产品设计');store.move({kind:'session',id:'original-session'},folder);store.move({kind:'group',id:'original-group'},folder);store.selectType('group')
 const again=createDialogueOrganization(memory),snapshot=again.getSnapshot()
 assert.equal(snapshot.assistantName,'松果');assert.equal(snapshot.type,'group');assert.equal(snapshot.placements[dialogueEntryKey({kind:'session',id:'original-session'})],folder);assert.equal(snapshot.placements[dialogueEntryKey({kind:'group',id:'original-group'})],folder)
 again.removeFolder(folder);assert.deepEqual(again.getSnapshot().placements,{})
 assert.equal(snapshot.folders[0]!.name,'产品设计','旧快照不被原地改写')
 again.renameAssistant('');assert.equal(again.getSnapshot().assistantName,'Teloa')
 assert.throws(()=>again.renameAssistant('x'.repeat(41)));assert.throws(()=>again.createFolder(''))
})
test('存储失败不能谎报已改名或丢掉原分组；损坏记录不静默覆盖',()=>{
 const memory=storage(),first=createDialogueOrganization(memory);first.createFolder('原分组')
 const original=first.getSnapshot(),broken=createDialogueOrganization({...memory,setItem:()=>{throw Error('写入失败')}})
 assert.throws(()=>broken.renameAssistant('另一个名字'));assert.deepEqual(broken.getSnapshot(),original)
 const key=[...memory.rows.keys()][0]!;memory.rows.set(key,'{损坏');const corrupt=createDialogueOrganization(memory)
 assert.ok(corrupt.getSnapshot().error);assert.throws(()=>corrupt.createFolder('不能覆盖'))
 assert.equal(memory.rows.get(key),'{损坏')
})
test('N48 会话｜员工｜群：默认只看会话，旧 all/session 持久筛选兼容迁移，分组与原身份不变',()=>{
 assert.equal(createDialogueOrganization(storage()).getSnapshot().type,'session','默认不再全部混合')
 for(const [stored,expected] of [['all','session'],['session','session'],['group','group']] as const){
  const memory=storage();memory.setItem('teloa.dialogue-organization/v1',JSON.stringify({schema:'teloa.dialogue-organization/v1',assistantName:'Teloa',type:stored,folders:[{id:'f1',name:'旧分组',collapsed:false}],placements:{[dialogueEntryKey({kind:'session',id:'s1'})]:'f1'}}))
  const store=createDialogueOrganization(memory),snapshot=store.getSnapshot()
  assert.equal(snapshot.error,undefined,stored+' 旧记录可读');assert.equal(snapshot.type,expected)
  assert.equal(snapshot.placements[dialogueEntryKey({kind:'session',id:'s1'})],'f1','原分组归属保留')
 }
 const memory=storage(),store=createDialogueOrganization(memory);store.selectType('employee')
 assert.equal(createDialogueOrganization(memory).getSnapshot().type,'employee','员工分类可持久')
 store.move({kind:'session',id:'employee-session'},null)
 assert.throws(()=>store.selectType('all' as never),'不再接受混合视图')
})
