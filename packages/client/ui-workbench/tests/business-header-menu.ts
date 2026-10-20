// 1.0 业务页头：另建会话、发起协作群、业务设置、刷新与固定收进「更多操作」菜单。
// 点击或计数前先展开；以 details.open 为准，aria-expanded 由原生 toggle 事件晚一帧同步。
export function businessMenuItem(scope:any,name:string){
 const menu=()=>scope.locator('summary[aria-label="更多操作"],summary[aria-label="More actions"]').first()
 const item=()=>scope.getByRole('button',{name,exact:true})
 const open=async()=>{if(await menu().count()&&!await menu().evaluate((summary:any)=>summary.parentElement.open))await menu().click()}
 return {
  click:async()=>{await open();await item().click()},
  count:async()=>{await open();return item().count()},
  waitFor:async(options?:{state?:'visible'|'hidden'|'attached'|'detached'})=>{if(options?.state==='hidden'||options?.state==='detached')return item().waitFor(options);await menu().waitFor();await open();await item().waitFor(options)},
 }
}
