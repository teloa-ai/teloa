export type AnchorNode={parentElement?:AnchorNode|null;getAttribute(name:string):string|null;querySelector(selectors:string):AnchorNode|null;scrollIntoView?(options?:{block:'center'}):void;focus?(options?:{preventScroll:boolean}):void;click?():void}

/** 在 root 内找 [data-teloa-anchor="<anchor>"]；若其内有 [aria-expanded="false"] 的按钮先 click 展开；scrollIntoView({block:'center'})；再 focus [data-teloa-focus="<target>"]（缺省或找不到则 focus 锚点内第一个 button，再退回锚点本身）。返回是否命中锚点。 */
export function focusObjectAnchor(root:AnchorNode|null,anchor:string,target?:string):boolean{
 const node=root?.querySelector(`[data-teloa-anchor="${anchor}"]`)
 if(!node)return false
 // 运行事件可能还在外层折叠组里；仅展开事件本身会把焦点留在不可见区域。
 for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement){
  if(parent.getAttribute('data-teloa-fold')!==null){
   // 只操作本层首个披露开关；跳过已展开开关去找 false 会误点内层表单两次。
   const toggle=parent.querySelector('[aria-expanded]')
   if(toggle?.getAttribute('aria-expanded')==='false')toggle.click?.()
  }
 }
 node.querySelector('[aria-expanded="false"]')?.click?.()
 const focus=()=>{
  node.scrollIntoView?.({block:'center'})
  const focusTarget=(target?node.querySelector(`[data-teloa-focus="${target}"]`):null)??node.querySelector('button')??node
  focusTarget.focus?.({preventScroll:true})
 }
 // 等待 React 展开详情，属性栏的内容在展开前尚未挂载。
 if(typeof requestAnimationFrame==='function')requestAnimationFrame(focus)
 else focus()
 return true
}
