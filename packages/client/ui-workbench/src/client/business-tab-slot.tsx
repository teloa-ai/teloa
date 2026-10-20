import {createContext,useContext,type ReactNode} from 'react'
import {createPortal} from 'react-dom'

/** 1.0 业务内页：页签行末尾的插槽，内页的「更多」菜单移到页签行；没有插槽（独立整页）时原地渲染。 */
export const BusinessTabSlot=createContext<HTMLElement|null>(null)
/** `scopeClassName` 让移入页签行的内容仍落在原页面的样式作用域里（容器不占布局）。 */
export function InBusinessTabs({children,className,scopeClassName}:{children:ReactNode;className?:string|undefined;scopeClassName?:string|undefined}){
 const slot=useContext(BusinessTabSlot)
 return slot?createPortal(<span className={scopeClassName} style={{display:'contents'}}>{children}</span>,slot):<div className={className}>{children}</div>
}
