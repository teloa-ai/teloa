import {useLayoutEffect,useRef} from 'react'
import {attachNativeComposerMenuViewport} from './native-composer-menu-viewport.js'
import css from './NativeComposerMenuViewport.module.css'

/** 与 DSH slash-menu 共用 overlay 插槽，不替换或重建原生菜单与富草稿。 */
export function NativeComposerMenuViewport({dismissCommandMenu}:{dismissCommandMenu:()=>boolean}){
 const marker=useRef<HTMLSpanElement>(null)
 const dismiss=useRef(dismissCommandMenu)
 dismiss.current=dismissCommandMenu
 useLayoutEffect(()=>{
  const anchor=marker.current?.closest<HTMLElement>('[data-composer-overlay]')
  if(anchor&&css.menu)return attachNativeComposerMenuViewport(anchor,css.menu,()=>dismiss.current())
 },[])
 return <span hidden ref={marker}/>
}
