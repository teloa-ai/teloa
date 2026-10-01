import type {ILayout,MainPanelId} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {WorkbenchActions} from './store.js'
import type {SettingsNavigation} from './settings-navigation.js'

type WorkbenchLayout=ILayout&{dispose():void}
export function createWorkbenchLayout(actions:WorkbenchActions,hasMainPanel:(id:MainPanelId)=>boolean,settings:SettingsNavigation):WorkbenchLayout{
  let navigation=new AbortController()
  return {
    selectPanel(panelId){
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
    beginNavigation(){navigation.abort();navigation=new AbortController();return navigation.signal},
    dispose(){navigation.abort()},
    toggleSidebar(){actions.toggleSidebar()},
    openRightbar(){actions.openRightbar()},
    closeRightbar(){actions.closeRightbar()},
  }
}
