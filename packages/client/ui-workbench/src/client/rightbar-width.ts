// 第三栏宽度的唯一真源：ui-layout 被 cordis.patch.yml 关掉后，原生的宽度偏好与把手都不存在，
// 这些常量直接抄 ui-layout 的 columns 契约，避免 Teloa 另立一套与原生不一致的范围。
//
// 关键约定：存储与组件状态里放的是「用户偏好」，不是夹过的值。夹一律发生在渲染期。
// 存夹过的值有两处损失：换窄屏再换回宽屏拿不回原偏好；开关会话目录来回一次宽度只收不放。
export const RIGHTBAR_MIN=300
export const RIGHTBAR_MAX_RATIO=0.7
export const RIGHTBAR_DEFAULT_RATIO=0.45
export const CENTER_MIN=400
/** 1380px 及以下轨道转覆盖模式，中栏不再被压缩。 */
export const RIGHTBAR_DOCKED_MIN_VIEWPORT=1381
/** 覆盖模式的抽屉宽度，与 WorkbenchFrame.module.css 的覆盖轨道共用这一个数。 */
export const RIGHTBAR_OVERLAY_WIDTH=420
/** 740px 及以下抽屉铺满视口。 */
export const RIGHTBAR_FULL_WIDTH_MAX_VIEWPORT=740
export const RIGHTBAR_KEYBOARD_STEP=16
export const RIGHTBAR_WIDTH_KEY='teloa-details-width'

const docked=(viewportWidth:number)=>viewportWidth>=RIGHTBAR_DOCKED_MIN_VIEWPORT

export function navigationTrackWidth(viewportWidth:number):number{
 // 1080 及以下主导航是 position:fixed 的抽屉，不占列宽。
 return viewportWidth<=1080?0:204
}

export function directoryTrackWidth(viewportWidth:number,directoryOpen:boolean):number{
 if(!directoryOpen)return 0
 if(viewportWidth<=RIGHTBAR_FULL_WIDTH_MAX_VIEWPORT)return 0
 if(viewportWidth<=1080)return 264
 if(viewportWidth<=1380)return 260
 return viewportWidth>=1600?296:280
}

export function rightbarWidthRange(viewportWidth:number,directoryOpen:boolean):{min:number;max:number}{
 const ratioMax=Math.floor(viewportWidth*RIGHTBAR_MAX_RATIO)
 const centerMax=docked(viewportWidth)
  ?viewportWidth-navigationTrackWidth(viewportWidth)-directoryTrackWidth(viewportWidth,directoryOpen)-CENTER_MIN
  :ratioMax
 return {min:RIGHTBAR_MIN,max:Math.max(RIGHTBAR_MIN,Math.min(ratioMax,centerMax))}
}

export function clampRightbarWidth(width:number,viewportWidth:number,directoryOpen:boolean):number{
 const {min,max}=rightbarWidthRange(viewportWidth,directoryOpen)
 return Math.min(max,Math.max(min,Math.round(width)))
}

/** 偏好默认值：只按视口 45% 取整，不夹。夹留给 rightbarTrackWidth，偏好才不会被当下布局写死。 */
export function defaultRightbarWidth(viewportWidth:number):number{
 return Math.round(viewportWidth*RIGHTBAR_DEFAULT_RATIO)
}

/** 读回的是偏好而不是当前可用宽度：上限不夹，只挡住小于下限的脏值。 */
export function readRightbarWidth(storage:Pick<Storage,'getItem'>,viewportWidth:number):number{
 let raw:string|null=null
 try{raw=storage.getItem(RIGHTBAR_WIDTH_KEY)}catch{return defaultRightbarWidth(viewportWidth)}
 const value=Number(raw)
 if(raw===null||raw.trim()===''||!Number.isFinite(value))return defaultRightbarWidth(viewportWidth)
 return Math.max(RIGHTBAR_MIN,Math.round(value))
}

export function writeRightbarWidth(storage:Pick<Storage,'setItem'>,width:number):void{
 // 存储不可用（隐私模式、配额满）不该让拖拽失败，宽度本轮仍然生效。
 try{storage.setItem(RIGHTBAR_WIDTH_KEY,String(Math.round(width)))}catch{/* 记忆丢失可接受 */}
}

/**
 * 轨道实际宽度：CSS 变量与 renderSlot('rightbar') 的 width 必须同时取这一个数，
 * 否则 DSH 面板的 style={{width}} 会与 Teloa 轨道错位（面板溢出轨道或轨道留白条）。
 * 覆盖模式的抽屉是固定尺寸，用户偏好只在停靠模式生效。
 */
export function rightbarTrackWidth(preferredWidth:number,viewportWidth:number,directoryOpen:boolean):number{
 if(docked(viewportWidth))return clampRightbarWidth(preferredWidth,viewportWidth,directoryOpen)
 if(viewportWidth<=RIGHTBAR_FULL_WIDTH_MAX_VIEWPORT)return viewportWidth
 return Math.min(RIGHTBAR_OVERLAY_WIDTH,Math.floor(viewportWidth*RIGHTBAR_MAX_RATIO))
}

/**
 * 传给 DSH 的 canShow。必须拿 rightbarTrackWidth 的结果来算：
 * DSH RightbarSeat 在 useLayoutEffect 里看到 canShow 为假会直接 setExpanded(false) 把右栏关掉，
 * 而 layout effect 先于父组件的 passive effect 跑，任何「下一帧再夹」的写法都会先关栏再变窄。
 */
export function rightbarCanShow(viewportWidth:number,directoryOpen:boolean,width:number):boolean{
 if(!docked(viewportWidth))return true
 return viewportWidth-navigationTrackWidth(viewportWidth)-directoryTrackWidth(viewportWidth,directoryOpen)-width>=CENTER_MIN
}

export function rightbarHandleVisible(viewportWidth:number):boolean{return docked(viewportWidth)}

/** 把手在左边缘，指针左移（deltaX 为负）意味着变宽。 */
export function resizeRightbarWidth(startWidth:number,deltaX:number,viewportWidth:number,directoryOpen:boolean):number{
 return clampRightbarWidth(startWidth-deltaX,viewportWidth,directoryOpen)
}

/** 键盘调节：左右箭头各走一步，Home/End 直达当前范围两端；其余按键交回组件处理。 */
export function stepRightbarWidth(current:number,key:string,viewportWidth:number,directoryOpen:boolean):number|null{
 const {min,max}=rightbarWidthRange(viewportWidth,directoryOpen)
 if(key==='Home')return min
 if(key==='End')return max
 if(key!=='ArrowLeft'&&key!=='ArrowRight')return null
 const delta=key==='ArrowLeft'?RIGHTBAR_KEYBOARD_STEP:-RIGHTBAR_KEYBOARD_STEP
 return clampRightbarWidth(current+delta,viewportWidth,directoryOpen)
}
