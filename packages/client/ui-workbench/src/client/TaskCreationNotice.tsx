import {useSyncExternalStore} from 'react'
import type {ConversationPlanEvents} from './conversation-plans.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {readTaskCreation,taskCreationWithoutDispatch} from './task-creation-receipt.js'
import {useI18n} from './i18n/provider.js'
import dock from './ComposerDock.module.css'

export function TaskCreationNotice({sessionId,storage,events,openForm}:{sessionId:string;storage:WorkbenchNavigationStorage;events:{getSnapshot:()=>ConversationPlanEvents;subscribe:(listener:()=>void)=>()=>void};openForm:(goal:string,scope:string)=>void}){
 const {t}=useI18n(),snapshot=useSyncExternalStore(events.subscribe,events.getSnapshot)
 const intent=readTaskCreation(storage,sessionId),goal=intent?taskCreationWithoutDispatch(snapshot):undefined
 if(!intent||!goal)return null
 return <div className={`${dock.strip} ${dock.warn}`} role="status"><p>{t('workbench.create.noTaskReceipt')}</p><button type="button" onClick={()=>openForm(goal,intent.scope)}>{t('workbench.create.taskForm')}</button></div>
}
