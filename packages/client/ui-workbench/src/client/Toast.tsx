import {createContext,useContext,useEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {CircleAlert,CircleCheck,Info,TriangleAlert,X} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import css from './Toast.module.css'

/**
 * Toast 回执（B8，对标报告第 2 节）：只给「结果离开了视野」的操作用，原位能看到结果的仍用行内回执。
 * 每条最多一个动作（撤销 / 查看）；成功 5 秒、带动作 8 秒，悬停或键盘聚焦时暂停；警告与错误不自动消失。
 */
export type ToastTone='success'|'info'|'warning'|'error'
export type ToastInput={tone?:ToastTone;message:string;action?:{label:string;run:()=>void|Promise<void>}|undefined}
export type ToastItem=ToastInput&{id:number;tone:ToastTone}
export type ToastApi={show:(input:ToastInput)=>number;dismiss:(id:number)=>void}
/** 时长：成功 5 秒〔Carbon〕、带动作 8 秒〔推断〕；警告 / 错误为 null，即常驻到本人关闭〔Atlassian、Primer〕。 */
export const toastDurations={plain:5000,action:8000}
export const toastDuration=(item:Pick<ToastItem,'tone'|'action'>,durations=toastDurations):number|null=>item.tone==='warning'||item.tone==='error'?null:item.action?durations.action:durations.plain
/** 同时最多 3 条，新的在上；超出时挤掉最早的一条。 */
export const TOAST_LIMIT=3

export type ToastStore=ToastApi&{subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>readonly ToastItem[]}
export function createToastStore():ToastStore{
 let items:readonly ToastItem[]=[],next=1
 const listeners=new Set<()=>void>()
 const publish=(value:readonly ToastItem[])=>{items=value;for(const listener of listeners)listener()}
 return {
  subscribe:listener=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
  getSnapshot:()=>items,
  show:input=>{const id=next++;publish([{...input,tone:input.tone??'success',id},...items].slice(0,TOAST_LIMIT));return id},
  dismiss:id=>{if(items.some(item=>item.id===id))publish(items.filter(item=>item.id!==id))},
 }
}

// 没有外壳时（单独渲染的组件、旧夹具）toast 静默不显示，不影响原操作本身。
const noop:ToastStore={show:()=>0,dismiss:()=>{},subscribe:()=>()=>{},getSnapshot:()=>[]}
const ToastContext=createContext<ToastStore>(noop)
export function ToastProvider({store,children}:{store?:ToastStore;children:ReactNode}){
 const [own]=useState(()=>store??createToastStore())
 return <ToastContext.Provider value={store??own}>{children}</ToastContext.Provider>
}
export function useToast():ToastApi{return useContext(ToastContext)}

/** 工作台外壳只挂一处：左下角叠放，避开右侧抽屉与底部居中的输入框。 */
export function ToastHost({durations=toastDurations}:{durations?:typeof toastDurations}){
 const store=useContext(ToastContext)
 const items=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot)
 return <div className={css.host} data-teloa-toasts="">{items.map(item=><ToastRow key={item.id} item={item} durations={durations} dismiss={()=>store.dismiss(item.id)}/>)}</div>
}

const icons={success:CircleCheck,info:Info,warning:TriangleAlert,error:CircleAlert} as const
function ToastRow({item,durations,dismiss}:{item:ToastItem;durations:typeof toastDurations;dismiss:()=>void}){
 const {t}=useI18n()
 const duration=toastDuration(item,durations)
 // 剩余时长按暂停累计：悬停或焦点在条内时停表，离开后从剩余时间继续。
 const remaining=useRef(duration),started=useRef(0),[hover,setHover]=useState(false),[focus,setFocus]=useState(false)
 const dismissRef=useRef(dismiss);dismissRef.current=dismiss
 const running=!hover&&!focus
 useEffect(()=>{
  if(remaining.current===null||!running)return
  started.current=Date.now()
  const timer=setTimeout(()=>dismissRef.current(),remaining.current)
  return ()=>{clearTimeout(timer);if(remaining.current!==null)remaining.current=Math.max(0,remaining.current-(Date.now()-started.current))}
 },[running])
 const Icon=icons[item.tone]
 const alert=item.tone==='error'||item.tone==='warning'
 return <div className={css.toast} data-tone={item.tone} role={alert?'alert':'status'} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)} onFocus={()=>setFocus(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocus(false)}}>
  <Icon size={15} className={css.icon} aria-hidden="true"/>
  <span className={css.message}>{item.message}</span>
  {item.action&&<button type="button" className={css.action} onClick={()=>{const action=item.action!;dismiss();void action.run()}}>{item.action.label}</button>}
  <button type="button" className={css.close} aria-label={t('toast.close')} onClick={dismiss}><X size={14}/></button>
 </div>
}
