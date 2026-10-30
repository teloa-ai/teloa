/** 目录的单聊、员工单聊与群共用一次导航；较新的点击立即撤销旧点击的打开权限。 */
export function createDialogueNavigation(){
 let active:AbortController|undefined
 return {
  begin(){active?.abort();const controller=new AbortController();active=controller;return controller.signal},
  cancel(){active?.abort();active=undefined},
 }
}
