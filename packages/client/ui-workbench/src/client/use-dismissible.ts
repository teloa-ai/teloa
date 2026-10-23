import {useEffect,useRef} from 'react'

const canFocus=(node:HTMLElement|null):node is HTMLElement=>!!node&&node!==document.body&&node!==document.documentElement&&node.isConnected!==false&&typeof node.focus==='function'&&(typeof node.getClientRects!=='function'||node.getClientRects().length>0)&&(typeof node.matches!=='function'||!node.matches(':disabled,[aria-disabled="true"]'))
const activeElement=():HTMLElement|null=>{
 const node=typeof document==='undefined'?null:document.activeElement
 return node&&typeof (node as HTMLElement).focus==='function'&&node!==document.body&&node!==document.documentElement?node as HTMLElement:null
}

/**
 * 弹层/菜单统一关闭：`open` 为真时监听 `pointerdown`（目标不在 `ref` 内即视为点在外面）与 `keydown` Escape，
 * 命中就调用 `close`。抽自 `WorkNavigation.tsx` 原本各自一份的 `closeFromOutside`/`closeFromKeyboard`。
 * 文档流中的展开区可选 click，避免按下时收起导致目标移位、吞掉本次点击。
 * 可选 `guard`：关闭前先问一句「现在能不能关」，返回 false 就跳过这一次
 *（例如「一句话描述」输入框有未提交内容时，不因为点外面而丢字，但 Esc 仍放行）。
 * 关闭后默认把焦点还给打开它的触发器（Esc、关闭按钮、选中后收起都适用）；外部点击关闭不抢用户刚点到的
 * 新焦点，触发器已失效或焦点已落到其他可见控件时也不抢。
 */
export function useDismissible(
 ref:{current:HTMLElement|null},
 open:boolean,
 close:()=>void,
 guard?:(source:'outside'|'escape')=>boolean,
 outsideEvent:'pointerdown'|'click'='pointerdown',
){
 const closeRef=useRef(close),guardRef=useRef(guard)
 closeRef.current=close;guardRef.current=guard
 useEffect(()=>{
  if(!open)return
  const trigger=activeElement()
  let restore=true
  const returnFocus=()=>{
   if(!restore)return
   queueMicrotask(()=>{
    if(!canFocus(trigger))return
    const active=document.activeElement
    if(active&&active!==document.body&&active!==document.documentElement&&active!==trigger&&!ref.current?.contains(active))return
    trigger.focus()
   })
  }
  const closeFromOutside=(event:MouseEvent)=>{
   if(event.target instanceof Node&&!ref.current?.contains(event.target)&&(!guardRef.current||guardRef.current('outside'))){restore=false;closeRef.current()}
  }
  const closeFromKeyboard=(event:KeyboardEvent)=>{
   if(event.key==='Escape'&&(!guardRef.current||guardRef.current('escape')))closeRef.current()
  }
  document.addEventListener(outsideEvent,closeFromOutside)
  document.addEventListener('keydown',closeFromKeyboard)
  return ()=>{document.removeEventListener(outsideEvent,closeFromOutside);document.removeEventListener('keydown',closeFromKeyboard);returnFocus()}
 },[open,outsideEvent])
}
