export type DirectoryFilterFocusable={focus:(options?:{preventScroll?:boolean})=>void}
export type DirectoryFilterPanel={querySelector:(selector:string)=>DirectoryFilterFocusable|null}
export type DirectoryFilterKeyEvent={key:string;preventDefault:()=>void;stopPropagation:()=>void}

const controlSelector='input:not(:disabled),select:not(:disabled),button:not(:disabled),[tabindex]:not([tabindex="-1"])'

export function focusFirstDirectoryFilterControl(panel:DirectoryFilterPanel|null):boolean{
  const control=panel?.querySelector(controlSelector)
  if(!control)return false
  control.focus({preventScroll:true})
  return true
}

export function handleDirectoryFilterEscape(event:DirectoryFilterKeyEvent,close:()=>void):boolean{
  if(event.key!=='Escape')return false
  event.preventDefault()
  event.stopPropagation()
  close()
  return true
}

export function restoreDirectoryFilterFocus(trigger:DirectoryFilterFocusable|null):void{
  queueMicrotask(()=>trigger?.focus({preventScroll:true}))
}

/** 目录菜单优先在入口下方展开；空间不足时翻转，内容在可用高度内滚动。 */
export function directoryFilterPosition(anchor:{right:number;top:number;bottom:number},width:number,height:number,viewportWidth:number,viewportHeight:number){
  const edge=8,gap=6
  const top=Math.max(edge,Math.min(anchor.top,viewportHeight-edge)),bottom=Math.max(edge,Math.min(anchor.bottom,viewportHeight-edge))
  const below=Math.max(0,viewportHeight-edge-bottom-gap),above=Math.max(0,top-gap-edge)
  const useAbove=below<height&&above>below,maxHeight=Math.min(height,useAbove?above:below)
  return {left:Math.max(edge,Math.min(anchor.right-width,viewportWidth-width-edge)),top:Math.max(edge,useAbove?top-gap-maxHeight:bottom+gap),maxHeight}
}
