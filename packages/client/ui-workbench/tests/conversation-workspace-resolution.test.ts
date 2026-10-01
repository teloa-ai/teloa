import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createConversationWorkspacePreferenceStore,
  resolveConversationWorkspace,
} from '../src/client/conversation-workspace-resolution.ts'

const workspaces=[
  {workspaceId:'workspace-teloa',title:'Teloa',path:'/Users/example/project/teloa',sessionIds:[]},
  {workspaceId:'workspace-other',title:'其他项目',path:'/Users/example/project/other',sessionIds:[]},
] as const

test('全局新建直接交给 DSH 使用真实默认工作区，不猜测登记列表顺序',()=>{
  assert.deepEqual(resolveConversationWorkspace({workspaces,scope:undefined}),{
    kind:'create',
    workspaceId:undefined,
  })
  assert.deepEqual(resolveConversationWorkspace({workspaces,scope:'general'}),{
    kind:'create',
    workspaceId:undefined,
  })
})

test('业务空间继承仍有效的默认运行位置，并把明确 id 传给 DSH',()=>{
  assert.deepEqual(resolveConversationWorkspace({workspaces,scope:'SOC',preferredWorkspaceId:'workspace-other'}),{
    kind:'create',
    workspaceId:'workspace-other',
  })
})

test('业务空间仅有一个已登记工作区时自动使用并建议保存为空间默认值',()=>{
  assert.deepEqual(resolveConversationWorkspace({workspaces:workspaces.slice(0,1),scope:'AppSec'}),{
    kind:'create',
    workspaceId:'workspace-teloa',
  })
})

test('业务空间没有可用默认或多个候选时才要求用户判断',()=>{
  assert.deepEqual(resolveConversationWorkspace({workspaces:[],scope:'SOC'}),{
    kind:'select',
    reason:'missing',
  })
  assert.deepEqual(resolveConversationWorkspace({workspaces,scope:'SOC'}),{
    kind:'select',
    reason:'ambiguous',
  })
})

test('业务空间登记表尚未就绪时不使用缓存候选，也不判定缓存已经失效',()=>{
  assert.deepEqual(resolveConversationWorkspace({workspaces,registryReady:false,scope:'SOC',preferredWorkspaceId:'workspace-other'}),{
    kind:'select',
    reason:'unavailable',
  })
  assert.deepEqual(resolveConversationWorkspace({workspaces,registryReady:false,scope:'general'}),{
    kind:'create',
    workspaceId:undefined,
  })
})

test('失效绑定绝不扩大目录权限，也不把未登记 id 传给 DSH',()=>{
  assert.deepEqual(resolveConversationWorkspace({workspaces,scope:'SOC',preferredWorkspaceId:'workspace-removed'}),{
    kind:'select',
    reason:'ambiguous',
    staleWorkspaceId:'workspace-removed',
  })
})

test('用户主动选择其他位置与未完成创建均进入选择或恢复流程',()=>{
  assert.deepEqual(resolveConversationWorkspace({workspaces,scope:'general',chooseOther:true}),{
    kind:'select',
    reason:'requested',
  })
  assert.deepEqual(resolveConversationWorkspace({workspaces,scope:'general',recovering:true,pendingWorkspaceId:'workspace-other'}),{
    kind:'select',
    reason:'recovery',
    initialWorkspaceId:'workspace-other',
  })
  assert.deepEqual(resolveConversationWorkspace({workspaces,scope:'general',recovering:true}),{
    kind:'select',
    reason:'recovery',
  })
})

test('业务空间默认位置使用版本化本机存储并拒绝畸形数据',()=>{
  const values=new Map<string,string>()
  const storage={
    getItem:(key:string)=>values.get(key)??null,
    setItem:(key:string,value:string)=>{values.set(key,value)},
    removeItem:(key:string)=>{values.delete(key)},
  }
  const preferences=createConversationWorkspacePreferenceStore(storage)
  preferences.write('SOC','workspace-other')
  assert.equal(preferences.read('SOC'),'workspace-other')
  preferences.remove('SOC')
  assert.equal(preferences.read('SOC'),undefined)
  values.set('teloa.conversation-workspace-preferences.v1','{"bindings":{"SOC":42}}')
  assert.equal(preferences.read('SOC'),undefined)
})
