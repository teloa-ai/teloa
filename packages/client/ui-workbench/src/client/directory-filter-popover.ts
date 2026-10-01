export type DirectoryFilterFocusable={focus:()=>void}
export type DirectoryFilterPanel={querySelector:(selector:string)=>DirectoryFilterFocusable|null}
export type DirectoryFilterKeyEvent={key:string;preventDefault:()=>void;stopPropagation:()=>void}

const controlSelector='input:not(:disabled),select:not(:disabled),button:not(:disabled),[tabindex]:not([tabindex="-1"])'

export function focusFirstDirectoryFilterControl(panel:DirectoryFilterPanel|null):boolean{
  const control=panel?.querySelector(controlSelector)
  if(!control)return false
  control.focus()
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
  queueMicrotask(()=>trigger?.focus())
}
