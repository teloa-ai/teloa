import type {ILayout,MainPanelId} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {WorkbenchActions} from './store.js'
import type {SettingsNavigation} from './settings-navigation.js'

type WorkbenchLayout=ILayout&{dispose():void;leaseSidebarToggle(toggle:()=>void):()=>void;deferNativeConversationNavigation(current:()=>boolean):()=>void}
export function createWorkbenchLayout(actions:WorkbenchActions,hasMainPanel:(id:MainPanelId)=>boolean,settings:SettingsNavigation,panelInfo:ILayout['panelInfo']):WorkbenchLayout{
  let navigation=new AbortController()
  let sidebarToggle:(()=>void)|undefined
  let conversationNavigation:{current:()=>boolean}|undefined
  return {
    panelInfo,
    selectPanel(panelId){
      // 原稿回填期间只暂缓本次目标会话的默认切页，选稿与本人守卫仍由调用方逐次核对。
      if(panelId===null&&conversationNavigation?.current())return
      conversationNavigation=undefined
      // 模型设置是 DSH 的 settings.section（id models），不是主面板：市场模型条目「去配置」经设置目录打开。
      if(panelId==='models'){
        navigation.abort()
        settings.select('models')
        actions.openDirectory()
        return
      }
      if(panelId!==null&&!hasMainPanel(panelId))throw Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
      navigation.abort()
      // 插件管理器已嵌入设置页；所有原生入口也必须经过同一目录。
      if(panelId==='plugins'){
        settings.select('teloa-native-panels')
        actions.openDirectory()
        return
      }
      actions.selectPanel(panelId)
    },
    beginNavigation(){navigation.abort();conversationNavigation=undefined;navigation=new AbortController();return navigation.signal},
    deferNativeConversationNavigation(current){const lease={current};conversationNavigation=lease;return()=>{if(conversationNavigation===lease)conversationNavigation=undefined}},
    dispose(){navigation.abort();sidebarToggle=undefined;conversationNavigation=undefined},
    leaseSidebarToggle(toggle){sidebarToggle=toggle;return()=>{if(sidebarToggle===toggle)sidebarToggle=undefined}},
    toggleSidebar(){if(sidebarToggle)sidebarToggle();else actions.toggleSidebar()},
    openRightbar(){actions.openRightbar()},
    closeRightbar(){actions.closeRightbar()},
  }
}
