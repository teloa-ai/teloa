import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import {openDetail,closeDetail,retainDetailForSession,artifactDetailTarget,type WorkbenchDetailSeeds,type WorkbenchDetailState,type WorkbenchDetailTarget} from './workbench-detail-target.js'
import type {ArtifactRef,ArtifactSourceRef} from './artifact-preview.js'
import type { BusinessTarget } from './business-preview.js'
import type { ContinuousTarget } from './continuous-preview.js'
import type { TemplatePlanSeed } from './plan-template.js'
import type { TemplateSeed } from './MarketForms.js'
import type { MarketCategory } from './market-home-presentation.js'
import {restoredBusinessTarget,restoredContinuousTarget,type WorkbenchDirectoryId,type WorkbenchDirectoryNavigation,type WorkbenchDirectoryPatch,type WorkbenchNavigationState} from './workbench-navigation-state.js'

export type WorkbenchView = 'home' | 'attention' | 'messages' | 'team' | 'spaces' | 'market' | 'resources' | 'tasks' | 'capabilities' | 'plans' | 'projects' | 'settings'

function showWorkbenchView(state:{view:WorkbenchView;panelInfo:{activePanelId:MainPanelId|null}},view:WorkbenchView):void{
  state.view=view
  state.panelInfo.activePanelId=null
}

const directorySelection=(current:WorkbenchDirectoryNavigation|undefined,id:string|null|undefined):WorkbenchDirectoryNavigation=>{
  const {selectedId:_,...rest}=current??{}
  return id?{...rest,selectedId:id}:rest
}

export function shouldFollowCurrentSession(previous:string|undefined,current:string|undefined,view:WorkbenchView):boolean{
  // 首次会话恢复仅同步状态，不抢占用户已经打开的首页或业务页面。
  return previous!==undefined&&previous!==current&&current!==undefined&&view!=='settings'&&view!=='home'
}

export function createWorkbenchStore(colorScheme: 'light'|'dark' = 'light',restored?:WorkbenchNavigationState) {
  return defineStore({
    init: () => ({ detail:restored?.detail??{open:false,target:null} as WorkbenchDetailState, detailSeeds:{} as WorkbenchDetailSeeds, rightbar:{shown:false}, view:restored?.view??'home' as WorkbenchView,settingsReturnView:(restored?.view==='settings'?'home':restored?.view??'home') as Exclude<WorkbenchView,'settings'>,searchFocusRequest:0,marketCategoryRequest:{category:'home',serial:0} as {category:MarketCategory|'home';serial:number},continuousTarget:(restored&&restoredContinuousTarget(restored))??{kind:'plans'} as ContinuousTarget,templatePlanSeed:null as TemplatePlanSeed|null,messageMode:restored?.messageMode??'native' as 'directory'|'native'|'groups', navOpen:false, directoryOpen:true, panelInfo:{activePanelId:null as MainPanelId|null},colorScheme, capabilitiesSession:null as string|null,resourceDraftId:null as string|null,resourceTarget:restored?.selected.resourceId?{id:restored.selected.resourceId,request:1}:null as {id:string;request:number}|null,resourceTargetRequest:restored?.selected.resourceId?1:0,taskId:restored?.selected.taskId??null as string|null,roleId:restored?.selected.roleId??null as string|null,groupTarget:null as {groupId:string;rootId:string}|null,businessTarget:(restored&&restoredBusinessTarget(restored))??{scope:'SOC',section:'overview'} as BusinessTarget,capabilityMode:restored?.capabilityMode??'catalog' as 'catalog'|'bindings',capabilityBindingId:restored?.selected.capabilityBindingId??null as string|null,capabilityVersion:null as number|null,marketMode:(restored?.marketMode==='industry-resources'?'catalog':restored?.marketMode??'catalog') as 'catalog'|'installations'|'industry-resources',installationId:restored?.selected.installationId??null as string|null,industryResourceTarget:null as {loadId?:string;itemInstanceId?:string;scope?:string}|null,marketItemId:restored?.selected.marketItemId??null as string|null,marketIntentId:restored?.selected.marketIntentId??null as string|null,templateSeed:null as TemplateSeed|null,navigationDirectories:restored?.directories??{} as Partial<Record<WorkbenchDirectoryId,WorkbenchDirectoryNavigation>> }),
    actions: {
      openDetail(state,target:WorkbenchDetailTarget){state.detail=openDetail(state.detail,target)},
      closeDetail(state){state.detail=closeDetail(state.detail)},
      // 切会话：把上一会话开着的详情记成它自己的种子，再把新会话的种子摆回来。
      // 真源是右栏页签（按会话各留各的），往返后页内详情必须跟着回来。
      retainDetailForSession(state,sessionId:string|undefined){
        const next=retainDetailForSession(state.detail,state.detailSeeds,sessionId)
        state.detail=next.detail;state.detailSeeds=next.seeds
      },
      openArtifacts(state,source:ArtifactSourceRef,artifact?:ArtifactRef,sessionId?:string){state.detail=openDetail(state.detail,artifactDetailTarget(source,artifact,sessionId));state.directoryOpen=false},
      openConversationObject(state,sessionId:string,object:{kind:'task'|'role';id:string;version?:number}){state.detail=openDetail(state.detail,{kind:'conversation-object',sessionId,objectKind:object.kind,id:object.id,...(object.version!==undefined?{version:object.version}:{})});state.directoryOpen=false},
      openConversationBusiness(state,sessionId:string,target:BusinessTarget){state.detail=openDetail(state.detail,{kind:'conversation-object',sessionId,objectKind:'business',target});state.directoryOpen=false},
      navigate(state, view: WorkbenchView) { showWorkbenchView(state,view);state.navOpen=false;if(view==='messages')state.messageMode='native' },
      openConversationDirectory(state){showWorkbenchView(state,'messages');state.messageMode='directory';state.directoryOpen=true;state.navOpen=false},
      openMessages(state,mode:'native'|'groups'){showWorkbenchView(state,'messages');state.messageMode=mode;state.navOpen=false},
      openResources(state,draftId?:string){showWorkbenchView(state,'resources');state.resourceDraftId=draftId??null;state.resourceTarget=null;state.navOpen=false},
      openResource(state,id:string){showWorkbenchView(state,'resources');state.resourceDraftId=null;state.resourceTargetRequest++;state.resourceTarget={id,request:state.resourceTargetRequest};state.navigationDirectories={...state.navigationDirectories,resources:{...state.navigationDirectories.resources,selectedId:id}};state.navOpen=false},
      clearResourceTarget(state){state.resourceTarget=null;if(state.detail.target?.kind==='directory-object'&&state.detail.target.view==='resources')state.detail={open:false,target:null}},
      preparePlan(state,seed:TemplatePlanSeed){showWorkbenchView(state,'plans');state.continuousTarget={kind:'plans'};state.templatePlanSeed=seed;state.navOpen=false},
      clearPlanSeed(state){state.templatePlanSeed=null},
      openPlans(state,target:ContinuousTarget={kind:'plans'}){showWorkbenchView(state,'plans');state.continuousTarget=target;state.navigationDirectories={...state.navigationDirectories,plans:directorySelection(state.navigationDirectories.plans,target.id)};state.navOpen=false},
      openAttention(state){showWorkbenchView(state,'attention');state.taskId=null;state.navigationDirectories={...state.navigationDirectories,tasks:directorySelection(state.navigationDirectories.tasks,null)};state.navOpen=false},
      openTask(state,id:string){showWorkbenchView(state,'tasks');state.taskId=id;state.navigationDirectories={...state.navigationDirectories,tasks:{...state.navigationDirectories.tasks,selectedId:id}};state.navOpen=false},
      selectTask(state,id:string|null){state.taskId=id;state.navigationDirectories={...state.navigationDirectories,tasks:directorySelection(state.navigationDirectories.tasks,id)}},
      openRole(state,id:string){showWorkbenchView(state,'team');state.roleId=id;state.navigationDirectories={...state.navigationDirectories,team:{...state.navigationDirectories.team,selectedId:id}};state.navOpen=false},
      selectRole(state,id:string|null){state.roleId=id;state.navigationDirectories={...state.navigationDirectories,team:directorySelection(state.navigationDirectories.team,id)}},
      openBinding(state,id:string|null,version?:number){showWorkbenchView(state,'capabilities');state.capabilityMode='bindings';state.capabilityBindingId=id;state.capabilityVersion=id?(version??null):null;state.navigationDirectories={...state.navigationDirectories,capabilities:directorySelection(state.navigationDirectories.capabilities,id)};state.navOpen=false},
      openCapabilityCatalog(state){showWorkbenchView(state,'capabilities');state.capabilityMode='catalog';state.capabilityBindingId=null;state.capabilityVersion=null;state.navOpen=false},
      openInstallations(state,id?:string){showWorkbenchView(state,'market');state.marketMode='installations';state.installationId=id??null;state.industryResourceTarget=null;state.navigationDirectories={...state.navigationDirectories,market:directorySelection(state.navigationDirectories.market,id)};state.navOpen=false},
      openMarket(state,itemId?:string,intentId?:string){showWorkbenchView(state,'market');state.marketMode='catalog';state.marketItemId=itemId??null;state.marketIntentId=intentId??null;state.industryResourceTarget=null;state.navigationDirectories={...state.navigationDirectories,market:directorySelection(state.navigationDirectories.market,itemId)};state.navOpen=false},
      /** 市场页常驻挂载、`kind` 只在首次挂载读目录；已挂载时要落到某个类目，靠这条按 serial 递增的受控请求（设置页等 Frame 外入口也走这里）。 */
      openMarketCategory(state,category:MarketCategory|'home'){showWorkbenchView(state,'market');state.marketMode='catalog';state.marketItemId=null;state.marketIntentId=null;state.industryResourceTarget=null;state.marketCategoryRequest={category,serial:state.marketCategoryRequest.serial+1};state.navigationDirectories={...state.navigationDirectories,market:directorySelection(state.navigationDirectories.market,null)};state.navOpen=false},
      openIndustryResources(state,target:{loadId?:string;itemInstanceId?:string;scope?:string}){showWorkbenchView(state,'market');state.marketMode='industry-resources';state.industryResourceTarget={...target};state.navOpen=false},
      openIndustrySkill(state,loadId:string,itemInstanceId:string){showWorkbenchView(state,'market');state.marketMode='industry-resources';state.industryResourceTarget={loadId,itemInstanceId};state.navOpen=false},
      saveTemplate(state,seed:TemplateSeed){showWorkbenchView(state,'market');state.marketMode='catalog';state.templateSeed=seed;state.navOpen=false},
      clearTemplateSeed(state){state.templateSeed=null},
      openBusiness(state,target:BusinessTarget){showWorkbenchView(state,'spaces');state.businessTarget=target;state.navigationDirectories={...state.navigationDirectories,spaces:directorySelection(state.navigationDirectories.spaces,target.id)};state.navOpen=false},
      openGroupTopic(state,groupId:string,rootId:string){showWorkbenchView(state,'messages');state.messageMode='groups';state.groupTarget={groupId,rootId};state.navOpen=false},
      toggleNavigation(state) {state.navOpen=!state.navOpen},
      closeNavigation(state) {state.navOpen=false},
      focusConversationSearch(state) {showWorkbenchView(state,'messages');state.messageMode='directory';state.directoryOpen=true;state.navOpen=false;state.searchFocusRequest++},
      closeSidebar(state) {state.directoryOpen=false},
      toggleSidebar(state) {state.directoryOpen=!state.directoryOpen},
      selectPanel(state,panelId:MainPanelId|null){
        // 读取任务成果需打开原生历史，但不应因此离开任务页、卸载正在整理的成果。
        const target=state.detail.target
        if(panelId===null&&state.detail.open&&target?.kind==='artifact'&&!target.sessionId&&target.source.kind!=='session'){
          state.panelInfo.activePanelId=null
          return
        }
        if(panelId!==null&&state.view!=='settings')state.settingsReturnView=state.view
        showWorkbenchView(state,panelId===null?'messages':'settings')
        state.panelInfo.activePanelId=panelId;state.messageMode='native';state.navOpen=false
      },
      retainMainPanels(state,panelIds:readonly string[]){if(state.panelInfo.activePanelId!==null&&!panelIds.includes(state.panelInfo.activePanelId))state.panelInfo.activePanelId=null},
      openDirectory(state) {if(state.view!=='settings')state.settingsReturnView=state.view;state.directoryOpen=true;showWorkbenchView(state,'settings');state.messageMode='native';state.navOpen=false},
      closeSettings(state) {showWorkbenchView(state,state.settingsReturnView);state.navOpen=false},
      // 原生右栏是否显示，与“开着哪个对象的详情”是两件互不替代的事：
      // 右栏现在同时承载官方页类型与 Teloa 的对象页签，把呈现写进 detail 会把对象身份覆盖掉
      // （开页签时 DSH 会同步一次 shown:true，正好盖在刚写好的 conversation-object 上）。
      // track 与 fullscreen 由 DSH 自己在右栏内部处置，Teloa 只需要知道这条轨道该不该占位。
      openRightbar(state){state.rightbar={shown:true}},
      closeRightbar(state){state.rightbar={shown:false}},
      openCapabilities(state, sessionId: string) {state.capabilitiesSession=sessionId},
      closeCapabilities(state) {state.capabilitiesSession=null},
      setColorScheme(state, value: 'light'|'dark') {state.colorScheme=value},
      rememberDirectory(state,id:WorkbenchDirectoryId,patch:WorkbenchDirectoryPatch){
        const current=state.navigationDirectories[id]
        const next:WorkbenchDirectoryNavigation={...current}
        for(const key of ['category','query','selectedId','scrollTop'] as const)if(Object.hasOwn(patch,key)){const value=patch[key];if(value===undefined)delete next[key];else Object.assign(next,{[key]:value})}
        // 页面会在挂载时把目录筛选同步回来；相同内容不能再次发布 store 快照，
        // 否则外壳传入的新导航回调会触发无意义重渲染循环。
        const keys=Object.keys(next)
        if(keys.length===Object.keys(current??{}).length&&keys.every(key=>next[key as keyof WorkbenchDirectoryNavigation]===current?.[key as keyof WorkbenchDirectoryNavigation]))return
        state.navigationDirectories={...state.navigationDirectories,[id]:next}
      },
      reconcileDirectory(state,view:WorkbenchDirectoryId,id:string|undefined,detail:WorkbenchDetailState){
        state.navigationDirectories={...state.navigationDirectories,[view]:directorySelection(state.navigationDirectories[view],id)}
        if(view==='tasks')state.taskId=id??null
        else if(view==='team')state.roleId=id??null
        else if(view==='resources')state.resourceTarget=null
        else if(view==='capabilities'){state.capabilityBindingId=id??null;if(!id)state.capabilityVersion=null}
        else if(view==='market'){if(state.marketMode==='catalog')state.marketItemId=id??null;else if(state.marketMode==='installations')state.installationId=id??null}
        state.detail=detail
      },
      reconcileBusiness(state,target:BusinessTarget,detail:WorkbenchDetailState){state.businessTarget=target;state.navigationDirectories={...state.navigationDirectories,spaces:directorySelection(state.navigationDirectories.spaces,target.id)};state.detail=detail},
      reconcileContinuous(state,target:ContinuousTarget,detail:WorkbenchDetailState){state.continuousTarget=target;state.navigationDirectories={...state.navigationDirectories,plans:directorySelection(state.navigationDirectories.plans,target.id)};state.detail=detail},
    },
  })
}

export type WorkbenchActions = BoundActions<ReturnType<typeof createWorkbenchStore>>
