import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { WorkspaceManagement,type WorkspaceManagementPort } from '../src/client/workspace-management.ts'
const row=(id:string,title=id)=>({workspaceId:id,path:'/project/'+id,title,sessionIds:[],createdAt:'2026-09-11T00:00:00Z',updatedAt:'2026-09-11T00:00:00Z'} as unknown as WorkspaceView)
function fixture(){
  let rows=[row('A'),row('B'),row('C')],ready=true,notify=()=>{}
  const calls:unknown[][]=[]
  const port:WorkspaceManagementPort={state:()=>({rows,ready,error:undefined}),subscribe:fn=>{notify=fn;return ()=>{}},create:async path=>{calls.push(['create',path]);return row('D')},rename:async(id,title)=>{calls.push(['rename',id,title]);return row(id,title)},remove:async id=>{calls.push(['remove',id])},move:async(id,before)=>{calls.push(['move',id,before])}}
  const model=new WorkspaceManagement(port)
  return {model,port,calls,replace:(value:WorkspaceView[])=>{rows=value;notify()},disconnect:()=>{ready=false;notify()}}
}
test('初始同步或断线不允许工作区写入',async()=>{
  const f=fixture();f.disconnect();f.model.setPath('/project/D')
  await f.model.create();assert.deepEqual(f.calls,[])
  assert.deepEqual(f.model.getSnapshot().error,{key:'workspaceSettings.error.connection'})
})
test('上下移使用最新目录中的稳定身份和正确锚点',async()=>{
  const f=fixture();await f.model.move('B','down');assert.deepEqual(f.calls,[['move','B',undefined]])
  f.replace([row('C'),row('A'),row('B')]);await f.model.move('A','up')
  assert.deepEqual(f.calls.at(-1),['move','A','C'])
  await f.model.move('C','up');assert.equal(f.calls.length,2)
})
test('重命名草稿跨关闭保留，源标题改动必须先复核',async()=>{
  const f=fixture();f.model.edit('A');f.model.setTitle('草稿');f.model.closeEditor();f.model.edit('A')
  assert.equal(f.model.getSnapshot().drafts.A?.value,'草稿')
  f.replace([row('A','外部改名'),row('B')]);await f.model.rename('A')
  assert.deepEqual(f.calls,[])
  assert.deepEqual(f.model.getSnapshot().error,{key:'workspaceSettings.error.nameChanged'})
  f.model.acceptCurrentTitle('A');await f.model.rename('A')
  assert.deepEqual(f.calls,[['rename','A','草稿']])
})

test('工作区成功提示只保存语义键和动态原文',async()=>{
  const f=fixture()
  f.model.setPath('/project/D');await f.model.create()
  assert.deepEqual(f.model.getSnapshot().notice,{key:'workspaceSettings.notice.added',params:{title:'D'}})
  f.model.edit('A');f.model.setTitle('新名称');await f.model.rename('A')
  assert.deepEqual(f.model.getSnapshot().notice,{key:'workspaceSettings.notice.nameSaved',params:{title:'新名称'}})
  await f.model.move('B','up')
  assert.deepEqual(f.model.getSnapshot().notice,{key:'workspaceSettings.notice.orderSaved'})
  await f.model.remove('A',true)
  assert.deepEqual(f.model.getSnapshot().notice,{key:'workspaceSettings.notice.removed',params:{title:'A'}})
})
test('移除要求确认具体身份，目录已移除时不操作同名替代项',async()=>{
  const f=fixture();await f.model.remove('A',false);assert.deepEqual(f.calls,[])
  f.replace([row('new-A','A'),row('B')]);await f.model.remove('A',true);assert.deepEqual(f.calls,[])
  await f.model.remove('new-A',true);assert.deepEqual(f.calls,[['remove','new-A']])
})
test('进行中的请求阻止重复写入，失败保留输入用于重试',async()=>{
  const f=fixture();let reject!:(error:Error)=>void
  f.port.create=path=>{f.calls.push(['create',path]);return new Promise((_,no)=>{reject=no})}
  f.model.setPath('/project/D');const first=f.model.create();await f.model.create();assert.equal(f.calls.length,1)
  reject(Error('暂不可用'));await first
  assert.equal(f.model.getSnapshot().path,'/project/D');assert.equal(f.model.getSnapshot().pending,undefined)
})
test('迟到的创建成功不清空期间的新目录草稿',async()=>{
  const f=fixture();let done!:(row:WorkspaceView)=>void
  f.port.create=()=>new Promise(resolve=>{done=resolve});f.model.setPath('/project/D')
  const first=f.model.create();f.model.setPath('/project/E');done(row('D'));await first
  assert.equal(f.model.getSnapshot().path,'/project/E')
})
