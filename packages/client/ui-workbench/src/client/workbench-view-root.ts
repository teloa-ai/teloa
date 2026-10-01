import type { WorkbenchView } from './store.js'

/** 顶栏面包屑第二级点击后回到的「列表根」：按视图选一个既有的根入口动作。 */
export type ViewRootAction=
 |{kind:'navigate';view:WorkbenchView}
 |{kind:'attention'}|{kind:'plans'}|{kind:'market'}|{kind:'resources'}|{kind:'business-home'}|{kind:'tasks'}|{kind:'team'}

export function viewRootAction(view:WorkbenchView):ViewRootAction{
 switch(view){
  case 'attention':return {kind:'attention'}
  case 'plans':return {kind:'plans'}
  case 'market':return {kind:'market'}
  case 'resources':return {kind:'resources'}
  case 'spaces':return {kind:'business-home'}
  case 'tasks':return {kind:'tasks'}
  case 'team':return {kind:'team'}
  default:return {kind:'navigate',view}
 }
}
