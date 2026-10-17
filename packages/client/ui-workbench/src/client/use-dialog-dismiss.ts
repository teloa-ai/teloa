import {useRef,type PointerEvent,type SyntheticEvent} from 'react'

/** 只处理当前模态本身；按下和松开都在窗外才关闭，子层和拖出不会误关。 */
export function useDialogDismiss(close:()=>void,canClose=true){
 const outsidePointer=useRef<number>()
 const outside=(event:PointerEvent<HTMLDialogElement>)=>{
  if(event.target!==event.currentTarget)return false
  const box=event.currentTarget.getBoundingClientRect()
  return event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom
 }
 return {
  onCancel:(event:SyntheticEvent<HTMLDialogElement>)=>{if(event.target!==event.currentTarget)return;event.preventDefault();event.stopPropagation();if(canClose)close()},
  onPointerDown:(event:PointerEvent<HTMLDialogElement>)=>{outsidePointer.current=outside(event)?event.pointerId:undefined},
  onPointerCancel:()=>{outsidePointer.current=undefined},
  onPointerUp:(event:PointerEvent<HTMLDialogElement>)=>{
   const dismiss=outsidePointer.current!==undefined&&outsidePointer.current===event.pointerId&&outside(event);outsidePointer.current=undefined
   if(dismiss&&canClose){event.stopPropagation();close()}
  },
 }
}
