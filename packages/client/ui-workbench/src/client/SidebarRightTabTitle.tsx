import {useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import {subscribeTeloaTabHost,teloaTabHostRevision} from './sidebar-right-tab-host.js'

/**
 * 活标题座位：`definition.title` 只在开页时捕获一次，语言切换或对象改名后要靠这里刷新。
 * 取不到实时标题（对象已不在、外壳尚未挂载）时退回开页时捕获的那一份，不留空页签。
 */
export function SidebarRightTabTitle({useTabInfo,label}:PropsRuntime<'sidebar.right.pane.tab.title'>&{label:(params:unknown)=>string|undefined}){
 const info=useTabInfo()
 useSyncExternalStore(subscribeTeloaTabHost,teloaTabHostRevision,teloaTabHostRevision)
 return <span>{label(info.tab.navigation.params)??info.tab.title}</span>
}
