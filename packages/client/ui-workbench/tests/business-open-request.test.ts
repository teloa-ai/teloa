import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {captureWorkbenchNavigationState,readWorkbenchNavigationState,writeWorkbenchNavigationState} from '../src/client/workbench-navigation-state.ts'
import {businessNavStep,businessTargetKey} from '../src/client/workbench-business-navigation.ts'
registerHooks({resolve(specifier,context,next){
 if(specifier==='./workbench-detail-target.js')return next('./workbench-detail-target.ts',context)
 if(specifier==='./workbench-navigation-state.js')return next('./workbench-navigation-state.ts',context)
 return next(specifier,context)
}})
const {createWorkbenchStore}=await import('../src/client/store.ts')
const target={scope:'sales',section:'projects',id:'11111111-1111-4111-8111-111111111111'} as const

test('统一显式打开请求区分相同对象的重复点击，普通导航与恢复不产生请求',()=>{
 const store=createWorkbenchStore().create()
 store.actions.rememberDirectory('spaces',{query:'保留筛选',scrollTop:240})
 store.actions.openBusiness(target)
 const first=store.getSnapshot()
 store.actions.navigate('messages');store.actions.openBusiness({...target})
 const second=store.getSnapshot()
 assert.equal(second.businessOpenRequest,first.businessOpenRequest+1)
 assert.deepEqual(second.businessTarget,target)
 assert.deepEqual(second.navigationDirectories.spaces,{query:'保留筛选',scrollTop:240,selectedId:target.id,businessHome:false})
 const entered=businessNavStep({viewSeen:'messages',targetSeen:businessTargetKey(target),openRequestSeen:first.businessOpenRequest},{kind:'open-request',request:second.businessOpenRequest})
 assert.equal(entered.home,false)
 assert.equal(businessNavStep(entered.seen,{kind:'view',view:'spaces'}).home,null,'随后视图观察不得覆盖显式打开')
 assert.equal(businessNavStep(entered.seen,{kind:'open-request',request:second.businessOpenRequest}).home,null,'重复观察同一请求不重放用户动作')
 store.actions.navigate('messages');store.actions.navigate('spaces')
 assert.equal(store.getSnapshot().businessOpenRequest,second.businessOpenRequest)
 const persisted=captureWorkbenchNavigationState(store.getSnapshot())
 assert.equal('businessOpenRequest' in persisted,false,'瞬时点击请求不进入恢复记录')
 const reloaded=createWorkbenchStore('light',persisted).create()
 assert.equal(reloaded.getSnapshot().businessOpenRequest,0)
 assert.deepEqual(reloaded.getSnapshot().businessTarget,target)
 reloaded.actions.reconcileBusiness({scope:'sales',section:'overview'},{open:false,target:null})
 assert.equal(reloaded.getSnapshot().businessOpenRequest,0,'目录恢复落定不冒充对象卡点击')
})

test('业务内页与本人返回首页分别同步持久化，刷新保留精确目标而不重新打开旧内页',()=>{
 const store=createWorkbenchStore().create()
 store.actions.openBusiness({scope:'sales',section:'dashboards',dashboardId:'review'})
 const saved=readWorkbenchNavigationState(writeWorkbenchNavigationState(captureWorkbenchNavigationState(store.getSnapshot())))
 assert.equal(saved.directories.spaces?.businessHome,false)
 const restored=createWorkbenchStore('light',saved).create()
 assert.deepEqual(restored.getSnapshot().businessTarget,{scope:'sales',section:'dashboards',dashboardId:'review'})
 assert.equal(restored.getSnapshot().navigationDirectories.spaces?.businessHome,false)
 restored.actions.navigate('spaces')
 const home=readWorkbenchNavigationState(writeWorkbenchNavigationState(captureWorkbenchNavigationState(restored.getSnapshot())))
 assert.equal(home.directories.spaces?.businessHome,true)
 assert.equal(businessNavStep({viewSeen:'spaces',targetSeen:businessTargetKey(target)},{kind:'settle',target,home:true}).home,true,'旧精确目标不得覆盖本人返回首页')
 assert.equal(businessNavStep({viewSeen:'spaces',targetSeen:businessTargetKey(target)},{kind:'settle',target:{scope:'sales',section:'overview'},home:false}).home,false,'同一业务总览也可恢复为内页')
})

test('业务首页标记只允许业务目录的严格布尔值，不放宽其他目录恢复格式',()=>{
 const store=createWorkbenchStore().create(),saved=captureWorkbenchNavigationState(store.getSnapshot())
 for(const businessHome of [false,true])assert.equal(readWorkbenchNavigationState(JSON.stringify({...saved,directories:{spaces:{businessHome}}})).directories.spaces?.businessHome,businessHome)
 assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...saved,directories:{spaces:{businessHome:'false'}}})))
 assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...saved,directories:{tasks:{businessHome:false}}})))
 const businessPage={scope:'sales',pageId:'review'}
 store.actions.rememberDirectory('spaces',{businessPage})
 assert.deepEqual(readWorkbenchNavigationState(writeWorkbenchNavigationState(captureWorkbenchNavigationState(store.getSnapshot()))).directories.spaces?.businessPage,businessPage)
 for(const page of [{scope:'',pageId:'review'},{scope:'sales',pageId:''},{scope:'sales',pageId:'review',dashboardId:'other'}])assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...saved,directories:{spaces:{businessPage:page}}})))
 assert.throws(()=>readWorkbenchNavigationState(JSON.stringify({...saved,directories:{tasks:{businessPage}}})))
})
