/** 对话框卸载后恢复可见入口；入口随导航消失时落回工作区。 */
export function openDialog(node:HTMLDialogElement|null,initial?:HTMLElement|null):()=>void {
  if(!node)return ()=>{}
  const document=node.ownerDocument
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null
  node.showModal()
  const visible=(element:HTMLElement)=>element.isConnected&&element.getClientRects().length>0&&!element.matches(':disabled,[aria-disabled="true"]')
  const focus=initial&&visible(initial)?initial:Array.from(node.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex]')).find(visible)
  focus?.focus()
  return ()=>{
    node.close()
    if(previous&&previous!==document.body&&previous.isConnected&&previous.getClientRects().length&&!previous.matches(':disabled'))previous.focus()
    else document.getElementById('teloa-main')?.focus()
  }
}
