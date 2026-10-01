import { useEffect,useRef,type KeyboardEvent,type MouseEvent,type FocusEvent } from 'react'

export type DirectoryScrollNode={
  scrollTop:number
  scrollHeight:number
  clientHeight:number
  querySelectorAll:(selectors:string)=>ArrayLike<DirectoryScrollNode>
  parentElement?:DirectoryScrollNode|null
  contains?:(node:unknown)=>boolean
  getClientRects?:()=>ArrayLike<unknown>
}

export type DirectoryPaneRoot={querySelectorAll:(selectors:string)=>ArrayLike<DirectoryScrollNode>}

/** 多个工作台页面同时保留在 DOM 时，只选择当前真正可见的目录面板。 */
export function visibleDirectoryPane(root:DirectoryPaneRoot|null):DirectoryScrollNode|undefined{
  if(!root)return undefined
  return Array.from(root.querySelectorAll('[data-teloa-pane="directory"]')).find(pane=>!pane.getClientRects||pane.getClientRects().length>0)
}

/** 目录面板自身可滚动时用面板，否则只选第一个真正可滚动的目录子容器。 */
export function directoryScroller(pane:DirectoryScrollNode):DirectoryScrollNode{
  if(pane.scrollHeight>pane.clientHeight)return pane
  const descendant=Array.from(pane.querySelectorAll('*')).find(node=>node.scrollHeight>node.clientHeight)
  if(descendant)return descendant
  for(let parent=pane.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight)return parent
  return pane
}

/**
 * 一律取整再回报。真实浏览器的 `scrollTop` 是小数（触控板与高 DPI 下的次像素滚动），
 * 而恢复记录的解析器按整数校验（`workbench-navigation-state.ts` 的 `optionalInteger`），
 * 小数会让**整条**工作台恢复记录写入失败——视图、目录与第三栏详情一起不落盘，
 * 刷新后什么都恢复不回来，用户只看到控制台一行警告。一像素的位置精度不值这个代价。
 */
export function directoryScrollTopForEvent(pane:DirectoryScrollNode,target:unknown):number|undefined{
  if(target&&typeof target==='object'){
    const node=target as Partial<DirectoryScrollNode>
    const related=target===pane||pane.contains?.(target)||node.contains?.(pane)
    if(related&&typeof node.scrollTop==='number'&&typeof node.scrollHeight==='number'&&typeof node.clientHeight==='number'&&node.scrollHeight>node.clientHeight)return Math.round(node.scrollTop)
  }
  const scroller=directoryScroller(pane)
  return target===scroller?Math.round(scroller.scrollTop):undefined
}

/** Escape 只关闭当前 Teloa 详情；打开的原生 dialog 继续拥有自己的取消语义。 */
export function closeDirectoryDetailOnEscape(event:KeyboardEvent<HTMLElement>,close:()=>void){
  if(event.key!=='Escape'||event.defaultPrevented)return
  if(event.target instanceof Element&&event.target.closest('dialog[open]'))return
  event.preventDefault()
  event.stopPropagation()
  close()
}

/** 只在 Teloa 自有目录／详情之间转移焦点，不观察或修改原生会话 DOM。 */
/**
 * 目录/详情两面之间的焦点接力。
 * `autoFocus=false` 只保留点击记账与容器 ref，不主动移动焦点：
 * 同一个页面被第二处（原生右栏页签）复用时，那份实例没有目录面，抢焦点会把用户从对话框里拽走。
 */
export function useDirectoryFocus(visible:boolean,selected:string|undefined,autoFocus=true){
  const ref=useRef<HTMLDivElement>(null),opener=useRef<{element:HTMLElement;key:string}>()
  const previous=useRef<{visible:boolean;selected:string|undefined}>({visible:false,selected:undefined})
  useEffect(()=>{
    const before=previous.current
    previous.current={visible,selected}
    const root=ref.current
    if(!visible||!root||!autoFocus)return
    if(selected&&(selected!==before.selected||!before.visible)){
      root.querySelector<HTMLElement>('[data-teloa-pane="detail"]')?.focus({preventScroll:true})
    }else if(!selected&&before.selected&&before.visible){
      const original=opener.current
      const key=original?.key??before.selected
      const entry=original&&root.contains(original.element)?original.element:Array.from(root.querySelectorAll<HTMLElement>('[data-teloa-pane="directory"] [data-teloa-entry]')).find(element=>element.dataset.teloaEntry===key)
      const target=entry&&root.contains(entry)&&entry.getClientRects().length&&!entry.matches(':disabled')?entry:root.querySelector<HTMLElement>('[data-teloa-pane="directory"]')
      target?.focus({preventScroll:true})
    }
  },[visible,selected,autoFocus])
  const onClickCapture=(event:MouseEvent<HTMLDivElement>)=>{
    if(!(event.target instanceof Element))return
    const entry=event.target.closest<HTMLElement>('[data-teloa-entry]')
    if(entry?.dataset.teloaEntry&&entry.closest('[data-teloa-pane="directory"]')){
      opener.current={element:entry,key:entry.dataset.teloaEntry}
      if(entry.getAttribute('aria-current')==='page'||entry.getAttribute('aria-selected')==='true')ref.current?.querySelector<HTMLElement>('[data-teloa-pane="detail"]')?.focus({preventScroll:true})
    }
  }
  // 键盘漫游也更新返回落点，否则选中下一行后 Esc 会回到上一次鼠标点击的行。
  const onFocusCapture=(event:FocusEvent<HTMLDivElement>)=>{
    if(!(event.target instanceof Element))return
    const entry=event.target.closest<HTMLElement>('[data-teloa-entry]')
    if(entry?.dataset.teloaEntry&&entry.closest('[data-teloa-pane="directory"]'))opener.current={element:entry,key:entry.dataset.teloaEntry}
  }
  // 表格行自己处理 Enter/空格，不会生成 click；重复打开同一行时 selected 不变，需显式接力。
  const onKeyDownCapture=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(!autoFocus||!visible||(event.key!=='Enter'&&event.key!==' '))return
    if(!(event.target instanceof Element))return
    const entry=event.target.closest<HTMLElement>('[data-teloa-entry][role="option"]')
    if(entry===event.target&&entry?.getAttribute('aria-selected')==='true'&&entry.closest('[data-teloa-pane="directory"]')){
      ref.current?.querySelector<HTMLElement>('[data-teloa-pane="detail"]')?.focus({preventScroll:true})
    }
  }
  return {ref,onClickCapture,onFocusCapture,onKeyDownCapture}
}
