import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'

/** 宿主桌面动作只供本机连接；远程浏览器看不到宿主打开的窗口。 */
export function installDesktopAppVisibility(ctx:Context):void{
 if(ctx.remote.$host.isLoopback)return
 const HiddenDesktopAction=()=>null
 for(const name of [
  'conversation.session.header.utilities',
  'sidebar.right.tab.files.actions',
  'sidebar.right.tab.document.actions',
  'sidebar.right.tab.document.unpreviewable',
  'deliverables.file.actions',
  'deliverables.review.file.actions',
 ] as const){
  ctx.slots.inject(name,()=>ctx.slots.register({name,id:'open-in-app',priority:-100},HiddenDesktopAction))
 }
}
