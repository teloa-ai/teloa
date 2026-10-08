import {LocalModelsSettings} from './LocalModelsSettings.js'
import type {LocalModelsApi,LocalModelsFocus} from './local-models-api.js'
import type {RuntimeSettingsSurface} from './runtime-settings-surface.js'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {SettingsNavigation} from './settings-navigation.js'
import {mainSessionSource} from './main-session.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { IWorkspaces,WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsShell,GeneralSettings,DeveloperToolsSettings,NativePanelsSettings,NativePluginDetailMarker,ComponentStatusSettings,SettingsDocumentAction,type SettingsEntry } from './SettingsShell.js'
import { WorkspaceManagement } from './workspace-management.js'
import { WorkspaceSettings } from './WorkspaceSettings.js'
import type { WebAccessApi } from './web-access-api.js'
import {ImChannelsSettingsPage,type ImChannelsSettingsProps} from './ImChannelsSettingsPage.js'
import type {TeloaTranslate} from './i18n/index.js'
import {applicationPresentation} from './application-presentation.js'

/** 不以声明或单一厂商弹窗阻挡设置；模型配置统一进入原生模型页。主动补录密钥仍归原插件。 */
const REPLACED_ONBOARDING_STEPS=new Set(['welcome-notice','deepseek-official'])

/** 日常偏好 → 运行配置 → 状态与版本；新插件的设置保留在组件状态之前。 */
const SETTINGS_SECTION_ORDER:Readonly<Record<string,number>>={general:0,'teloa-auto-dream':10,models:20,'teloa-local-models':25,'teloa-workspaces':30,'teloa-native-panels':40,'agent-presets':50,'teloa-im-channels':65,plugins:70,'teloa-about':80}

/** 读取公开注册目录；配置页面和引导步骤仍由原生插件注册。 */
function directory(ctx:Context,key:'settings.section'|'settings.onboarding'|'sidebar.panellist'){
  let version=-1,revision=-1,rows:readonly SettingsEntry[]=[]
  return {
    getSnapshot:()=>{
      const next=ctx.slots.getVersion(key),locale=ctx.locale.getSnapshot().revision
      if(next!==version||locale!==revision){version=next;revision=locale;rows=ctx.slots.entriesOfSlot(key).filter(entry=>key!=='settings.onboarding'||!REPLACED_ONBOARDING_STEPS.has(entry.options.id!)).map(entry=>({id:entry.options.id!,order:entry.options.order??0,label:resolveSlotLabel(entry.options.label)??''})).sort((a,b)=>(key==='settings.section'?(SETTINGS_SECTION_ORDER[a.id]??60)-(SETTINGS_SECTION_ORDER[b.id]??60):0)||a.order-b.order)}
      return rows
    },
    subscribe:(listener:()=>void)=>{const slots=ctx.slots.subscribe(key,listener),locale=ctx.locale.subscribe(listener);return ()=>{slots();locale()}},
  }
}

export function installSettingsShell(ctx:Context,navigation:{open:()=>void;close:()=>void;selection:SettingsNavigation},t:TeloaTranslate,webAccessApi:WebAccessApi,runtimeSettings:RuntimeSettingsSurface,imChannels:ImChannelsSettingsProps,localModels?:{api:LocalModelsApi;focus:LocalModelsFocus}):void{
  // 应用桥在装配前已读取；宿主分配执行位置时不提供执行位置分区及其本机目录管理。
  if(applicationPresentation.getExecutionPlacement()==='user-selected')ctx.inject(['workspaces','connection'],child=>{
    const workspaces=child.workspaces as unknown as IWorkspaces
    const connection=Reflect.get(child,'connection') as unknown as ConnectionHandle
    const management=new WorkspaceManagement({
      state:()=>{const state=workspaces.list.getSnapshot();return {rows:state.items,ready:connection.state.getSnapshot()==='connected'&&state.phase==='ready'&&state.state==='idle'&&!state.error,error:state.error?.message}},
      subscribe:listener=>{const offRows=workspaces.list.subscribe(listener),offConnection=connection.state.subscribe(listener);return ()=>{offRows();offConnection()}},
      create:path=>workspaces.create({path}),
      rename:(id,title)=>workspaces.rename(brandString<WorkspaceId>(id),title),
      remove:id=>workspaces.delete(brandString<WorkspaceId>(id)),
      move:(id,before)=>workspaces.insertBefore(brandString<WorkspaceId>(id),before===undefined?undefined:brandString<WorkspaceId>(before)),
    })
    child.slots.inject('settings.section',()=>child.slots.register({name:'settings.section',id:'teloa-workspaces',order:5,label:()=>t('settings.workspace'),inject:()=>({management})},WorkspaceSettings))
    return ()=>management.dispose()
  })
  ctx.inject(['slots','sessions','connection','locale','configForms','uiSession','layout','remote','remote.settings'],child=>{
    const connection=Reflect.get(child,'connection') as unknown as ConnectionHandle
    const remote=Reflect.get(child,'remote') as ClientRemote
    const mainSession=mainSessionSource(child.uiSession)
    const describe=child.configForms.describe(),sections=directory(child,'settings.section'),onboarding=directory(child,'settings.onboarding')
    child.slots.inject('sidebar.settings',()=>child.slots.register({name:'sidebar.settings',children:{
      'settings.header':{kind:'single',scope:'root'},
      'settings.action':{kind:'list',scope:'root'},
      'settings.section':{kind:'list',scope:'root'},
      'settings.onboarding':{kind:'list',scope:'root'},
    },inject:()=>({mainSession,connection,sections,onboarding,selection:navigation.selection,open:navigation.open,close:navigation.close})},SettingsShell))
    child.slots.inject('settings.section',()=>child.slots.register({name:'settings.section',id:'general',order:0,label:()=>t('settings.general'),children:{'settings.general.item':{kind:'list',scope:'root'}},inject:()=>({sections})},GeneralSettings))
    child.slots.inject('settings.general.item',()=>child.slots.register({name:'settings.general.item',id:'developer-tools',order:15,inject:()=>({preference:child.configForms.developerTools})},DeveloperToolsSettings))
    // 网页策略复用装配根的单例 API，迁移入口不另建恢复记录或改变授权。
    child.slots.inject('settings.section',()=>child.slots.register({name:'settings.section',id:'teloa-native-panels',order:10,label:()=>t('teamCapability.runtime.manage'),inject:()=>({surface:runtimeSettings,webAccessApi})},NativePanelsSettings))
    child.slots.inject('settings.section',()=>child.slots.register({name:'settings.section',id:'teloa-im-channels',order:15,label:()=>t('imChannels.title'),inject:()=>imChannels},ImChannelsSettingsPage))
    if(localModels)child.slots.inject('settings.section',()=>child.slots.register({name:'settings.section',id:'teloa-local-models',order:25,label:()=>t('localModels.title'),inject:()=>localModels},LocalModelsSettings))
    child.slots.inject('plugins.detail.actions',()=>child.slots.register({name:'plugins.detail.actions',id:'teloa-settings-detail-scope'},NativePluginDetailMarker))
    child.slots.inject('settings.section',()=>child.slots.register({name:'settings.section',id:'plugins',order:15,label:()=>t('settings.systemComponents'),children:{'settings.plugins.tab':{kind:'list',scope:'root'}}},ComponentStatusSettings))
    child.slots.inject('settings.action',()=>child.slots.register({name:'settings.action',id:'open-document',order:0,inject:()=>({describe,loopback:remote.$host.isLoopback,openDocument:async()=>{const result=await remote.settings.openSettingsDocument();if(!result.ok)throw Error(result.error.message)}})},SettingsDocumentAction))
  })
}
