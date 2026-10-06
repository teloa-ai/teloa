import assert from 'node:assert/strict'
import test from 'node:test'
import {createWorkbenchNavigationStorage} from '../src/client/workbench-navigation-storage.ts'
import {HomeNativeController} from '../src/client/home-native-controller.ts'
import {emptyWorkbenchNavigationState,loadWorkbenchNavigationState,persistWorkbenchNavigationState} from '../src/client/workbench-navigation-state.ts'

const memory=()=>{const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}}
const scope='a'.repeat(64)

test('原生重建 WebContents 后恢复导航、首页待用会话及执行位置，不产生新会话身份',async()=>{
 const localStorage=memory(),first=createWorkbenchNavigationStorage(scope,{localStorage,sessionStorage:memory()})
 const navigation={...emptyWorkbenchNavigationState(),view:'messages' as const,detail:{open:true,target:{kind:'artifact' as const,source:{kind:'session' as const,id:'real-session'},sessionId:'real-session'}}}
 persistWorkbenchNavigationState(first,navigation)
 let ids=0;const calls:string[]=[]
 const port={identity:()=>`draft-${++ids}`,isBlank:()=>true,create:async(id:string)=>{calls.push(id);return id}}
 assert.equal(await new HomeNativeController({...port,storage:first}).prepare(),'draft-1')
 first.setItem('teloa.home-native-workspace/draft-1','workspace-1')
 const rebuilt=createWorkbenchNavigationStorage(scope,{localStorage,sessionStorage:memory()})
 assert.deepEqual(loadWorkbenchNavigationState(rebuilt),navigation)
 assert.equal(rebuilt.getItem('teloa.home-native-workspace/draft-1'),'workspace-1')
 assert.equal(await new HomeNativeController({...port,storage:rebuilt}).prepare(),'draft-1')
 assert.equal(ids,1);assert.deepEqual(calls,['draft-1','draft-1'])
})

test('新账号或安装 scope 不读取旧选中；删除恢复记录只影响本 scope',()=>{
 const localStorage=memory(),sessionStorage=memory(),sources={localStorage,sessionStorage}
 const first=createWorkbenchNavigationStorage(scope,sources),other=createWorkbenchNavigationStorage('b'.repeat(64),sources)
 first.setItem('teloa.home-native-session/v1','draft-A')
 persistWorkbenchNavigationState(first,{...emptyWorkbenchNavigationState(),view:'tasks',selected:{taskId:'task-A'}})
 assert.deepEqual(loadWorkbenchNavigationState(other),emptyWorkbenchNavigationState())
 assert.equal(other.getItem('teloa.home-native-session/v1'),null)
 assert.deepEqual(loadWorkbenchNavigationState(createWorkbenchNavigationStorage(undefined,sources)),emptyWorkbenchNavigationState())
 other.setItem('teloa.home-native-session/v1','draft-B')
 other.removeItem('teloa.home-native-session/v1')
 assert.equal(first.getItem('teloa.home-native-session/v1'),'draft-A')
 assert.throws(()=>createWorkbenchNavigationStorage('owner@example.test',sources))
})

test('未提供原生 scope 的普通 Web 复用原 sessionStorage，标签页关闭仍不共享导航',()=>{
 const localStorage=memory(),sessionStorage=memory()
 const browser=createWorkbenchNavigationStorage(undefined,{localStorage,sessionStorage})
 assert.equal(browser,sessionStorage)
 persistWorkbenchNavigationState(browser,{...emptyWorkbenchNavigationState(),view:'settings'})
 assert.equal(loadWorkbenchNavigationState(browser).view,'settings')
 assert.deepEqual(loadWorkbenchNavigationState(createWorkbenchNavigationStorage(undefined,{localStorage,sessionStorage:memory()})),emptyWorkbenchNavigationState())
})
