import {useEffect,useState,type KeyboardEvent as ReactKeyboardEvent,type MouseEvent as ReactMouseEvent} from 'react'

/** 版本开关只读：本阶段宿主只会回 `'personal'`，另外两档先留在类型里供后续许可状态接入。 */
export type Edition='personal'|'professional'|'enterprise'

type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>

const exact=(value:unknown,keys:readonly string[])=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw Error()
 return value as Record<string,unknown>
}

/**
 * 严格读取：只认 `{edition:'personal'}`，其余取值一律按宿主回包格式不正确处理。
 * 后端放开 `professional`/`enterprise` 时**必须同步放开这里**，否则新版本的宿主会被客户端当成坏回包，
 * 经 `configureEdition` 静默降级成个人版，企业版入口反而被门控挡住。
 */
export function readEdition(value:unknown):Edition{
 try{
  const row=exact(value,['edition'])
  if(row.edition!=='personal')throw Error()
  return 'personal'
 }catch{throw Error('版本信息格式不正确。')}
}

export function createEditionApi(call:Call){
 return {async read(signal?:AbortSignal):Promise<Edition>{return readEdition(await call('app/edition',{},signal))}}
}

export type EditionApi=ReturnType<typeof createEditionApi>

// 版本在一次运行里读一次：模块级缓存的 Promise 保证多处 `useEdition()` 只产生一次请求。
let pending:Promise<Edition>|undefined

/** 装配时调用一次；读不到版本时按最小可用版本 `'personal'` 处理并记录错误，不阻塞界面。 */
export function configureEdition(api:Pick<EditionApi,'read'>):Promise<Edition>{
 pending??=api.read().catch(error=>{console.error('读取版本信息失败，按个人版处理。',error);return 'personal' as const})
 return pending
}

/** 仅供测试重置模块级缓存。 */
export function resetEdition():void{pending=undefined}

export function useEdition():Edition{
 const [edition,setEdition]=useState<Edition>('personal')
 useEffect(()=>{
  const request=pending
  if(!request)return
  let active=true
  void request.then(value=>{if(active)setEdition(value)})
  return ()=>{active=false}
 },[])
 return edition
}

type GateEvent={preventDefault:()=>void;stopPropagation:()=>void}

/** 门控里的点击一律吞掉：既不触发被包裹控件自己的处理函数，也不冒泡到外层菜单，更不发请求。 */
export function interceptEditionGateClick(event:GateEvent,open:()=>void):void{
 event.preventDefault()
 event.stopPropagation()
 open()
}

/** 只有 Enter 与空格算“激活”；方向键等仍留给原控件的键盘导航。 */
export function interceptEditionGateKey(event:GateEvent&{key:string},open:()=>void):boolean{
 if(event.key!=='Enter'&&event.key!==' ')return false
 event.preventDefault()
 event.stopPropagation()
 open()
 return true
}

/**
 * 门控覆盖到被包裹控件上的属性：`onClick`/`onKeyDown` 一律换成门控自己的处理函数，
 * 原控件的处理函数因此不可能被调用。
 */
export function editionGateProps(feature:string,open:()=>void){
 return {
  'aria-disabled':true,
  'data-edition-gate':feature,
  onClick:(event:ReactMouseEvent)=>interceptEditionGateClick(event,open),
  onKeyDown:(event:ReactKeyboardEvent)=>{interceptEditionGateKey(event,open)},
 }
}
