import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {createSettingsNavigation} from '../src/client/settings-navigation.ts'
import {createWorkbenchLayout} from '../src/client/workbench-layout.ts'
import type {MainPanelId} from '@deepseek-ai/dsh-client-ui-layout/client'
import {mount,nodes} from './market-component-harness.ts'

registerHooks({resolve(specifier,context,next){
  if(specifier==='./workbench-detail-target.js')return next('./workbench-detail-target.ts',context)
  if(specifier==='./workbench-navigation-state.js')return next('./workbench-navigation-state.ts',context)
  return next(specifier,context)
}})
const {createWorkbenchStore}=await import('../src/client/store.ts')

test('原生插件入口打开设置内的连接与运行环境，保留返回位置',()=>{
  const store=createWorkbenchStore().create(),settings=createSettingsNavigation()
  const layout=createWorkbenchLayout(store.actions,id=>id==='plugins',settings,{getSnapshot:()=>store.getSnapshot().panelInfo,subscribe:listener=>store.subscribe(listener)})
  store.actions.openCapabilityCatalog()
  settings.select('teloa-about')
  const pending=layout.beginNavigation()
  layout.selectPanel('plugins' as MainPanelId)
  assert.equal(pending.aborted,true)
  assert.equal(store.getSnapshot().view,'settings')
  assert.equal(store.getSnapshot().panelInfo.activePanelId,null,'不再打开框架外的独立插件页')
  assert.equal(settings.getSnapshot(),'teloa-native-panels')
  settings.select('models')
  layout.selectPanel('plugins' as MainPanelId)
  assert.equal(settings.getSnapshot(),'teloa-native-panels','再次进入时覆盖旧的设置页签')
  store.actions.closeSettings()
  assert.equal(store.getSnapshot().view,'capabilities')
  layout.dispose()
})

test('市场模型条目「去配置」：models 不是主面板，改为打开设置并选中模型设置页',()=>{
  const store=createWorkbenchStore().create(),settings=createSettingsNavigation()
  const layout=createWorkbenchLayout(store.actions,id=>id==='plugins',settings,{getSnapshot:()=>store.getSnapshot().panelInfo,subscribe:listener=>store.subscribe(listener)})
  store.actions.openCapabilityCatalog()
  settings.select('teloa-about')
  const pending=layout.beginNavigation()
  layout.selectPanel('models' as MainPanelId)
  assert.equal(pending.aborted,true)
  assert.equal(store.getSnapshot().view,'settings')
  assert.equal(store.getSnapshot().panelInfo.activePanelId,null)
  assert.equal(settings.getSnapshot(),'models')
  layout.dispose()
})

test('其他原生面板和会话导航保持原行为，未知面板不改变当前页面',()=>{
  const store=createWorkbenchStore().create(),settings=createSettingsNavigation()
  const panelInfo={getSnapshot:()=>store.getSnapshot().panelInfo,subscribe:(listener:()=>void)=>store.subscribe(listener)}
  const layout=createWorkbenchLayout(store.actions,id=>id==='workspace-settings',settings,panelInfo)
  assert.equal(layout.panelInfo,panelInfo,'原生服务与根 hook 必须共享同一个选中态来源')
  const selections:(MainPanelId|null)[]=[]
  const off=layout.panelInfo.subscribe(()=>selections.push(layout.panelInfo.getSnapshot().activePanelId))
  layout.selectPanel('workspace-settings' as MainPanelId)
  assert.equal(store.getSnapshot().panelInfo.activePanelId,'workspace-settings')
  assert.throws(()=>layout.selectPanel('missing' as MainPanelId),/not registered/)
  assert.equal(store.getSnapshot().panelInfo.activePanelId,'workspace-settings')
  layout.selectPanel(null)
  assert.equal(store.getSnapshot().view,'messages')
  assert.equal(store.getSnapshot().panelInfo.activePanelId,null)
  assert.deepEqual(selections,['workspace-settings',null])
  off()
  layout.dispose()
})

test('设置外部入口、目录按钮和引导步骤共享同一个选中态',()=>{
  const page=mount('SettingsShell.tsx'),layout=mount('SettingsLayout.tsx'),selection=createSettingsNavigation()
  const rows=[{id:'general',label:'通用设置',order:0},{id:'teloa-native-panels',label:'连接与运行环境',order:1}]
  const props={selection,mainSession:{getSnapshot:()=>undefined,subscribe:()=>()=>{}},connection:{state:{getSnapshot:()=>'connected',subscribe:()=>()=>{}}},useSessions:(select:any)=>select({phase:'ready',byId:{}}),sections:{getSnapshot:()=>rows,subscribe:()=>()=>{}},onboarding:{getSnapshot:()=>[{id:'setup'}],subscribe:()=>()=>{}},open:()=>{},close:()=>{},renderSlot:(name:string,slotProps:any,options:any)=>({type:'slot',props:{name,...slotProps,...options},children:[]})}
  const render=()=>nodes(page.render('SettingsShell',props))
  assert.equal(render().find(node=>node.props.name==='settings.section')?.props.only,'general')
  selection.select('teloa-native-panels')
  assert.equal(render().find(node=>node.props.name==='settings.section')?.props.only,'teloa-native-panels')
  const presentation=render().find(node=>node.props.entries!==undefined)!
  nodes(layout.render('SettingsLayout',presentation.props)).find(node=>node.props.id==='settings-entry-general')!.props.onClick()
  assert.equal(selection.getSnapshot(),'general')
  render().find(node=>node.props.name==='settings.onboarding')!.props.openSection('teloa-native-panels')
  assert.equal(selection.getSnapshot(),'teloa-native-panels')
})
