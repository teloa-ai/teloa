type Location={view:string;messageMode?:unknown;taskId?:unknown;roleId?:unknown;resourceTarget?:unknown;capabilityBindingId?:unknown;marketItemId?:unknown;businessTarget?:unknown;continuousTarget?:unknown;groupTarget?:unknown;panelInfo?:{activePanelId:unknown}}
/** 只投影用户选中的页面与对象；后台数据刷新不会夺走创建流程的导航权。 */
export function homeCreationLocation(state:Location):string{
 return JSON.stringify([state.view,state.messageMode,state.taskId,state.roleId,state.resourceTarget,state.capabilityBindingId,state.marketItemId,state.businessTarget,state.continuousTarget,state.groupTarget,state.panelInfo?.activePanelId])
}
export function mayContinueHomeCreation(start:string,state:Location,currentSession:string|undefined,createdSession:string):boolean{
 return currentSession===createdSession&&(homeCreationLocation(state)===start||state.view==='messages'&&state.messageMode==='native')
}
