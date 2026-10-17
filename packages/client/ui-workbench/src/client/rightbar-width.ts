// 第三栏宽度的唯一真源：ui-layout 被 cordis.patch.yml 关掉后，原生的宽度偏好与把手都不存在，
// 这些常量直接抄 ui-layout 的 columns 契约，避免 Teloa 另立一套与原生不一致的范围。
//
// 关键约定：存储与组件状态里放的是「用户偏好」，不是夹过的值。夹一律发生在渲染期。
// 存夹过的值有两处损失：换窄屏再换回宽屏拿不回原偏好；开关会话目录来回一次宽度只收不放。
import type {ISidebarRight} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export const RIGHTBAR_MIN=300
export const RIGHTBAR_MAX_RATIO=0.7
export const RIGHTBAR_DEFAULT_RATIO=0.45
export const CENTER_MIN=400
/** 主栏与工作概览最小宽度之和；不足时由原生 canShow 收起，保留开启入口。 */
export const RIGHTBAR_DOCKED_MIN_VIEWPORT=CENTER_MIN+RIGHTBAR_MIN
/** 740px 及以下目录不占轨道。 */
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
 const centerMax=viewportWidth-navigationTrackWidth(viewportWidth)-directoryTrackWidth(viewportWidth,directoryOpen)-CENTER_MIN
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
 * 所有可容纳的桌面宽度均为非模态并栏，不覆盖会话输入。
 */
export function rightbarTrackWidth(preferredWidth:number,viewportWidth:number,directoryOpen:boolean):number{
 return clampRightbarWidth(preferredWidth,viewportWidth,directoryOpen)
}

/**
 * 传给 DSH 的 canShow。必须拿 rightbarTrackWidth 的结果来算：
 * DSH RightbarSeat 在 useLayoutEffect 里看到 canShow 为假会直接 setExpanded(false) 把右栏关掉，
 * 而 layout effect 先于父组件的 passive effect 跑，任何「下一帧再夹」的写法都会先关栏再变窄。
 */
export function rightbarCanShow(viewportWidth:number,directoryOpen:boolean,width:number):boolean{
 return viewportWidth-navigationTrackWidth(viewportWidth)-directoryTrackWidth(viewportWidth,directoryOpen)-width>=CENTER_MIN
}

/** 打开右栏时，目录是否还能继续占据并栏轨道。 */
export function rightbarDirectoryForOpening(viewportWidth:number,directoryOpen:boolean):boolean{
 // 原生 768px 以下的全屏规则保持；桌面空间足够时也不改变目录选择。
 if(!directoryOpen||viewportWidth<768||rightbarCanShow(viewportWidth,true,RIGHTBAR_MIN))return directoryOpen
 // 只有目录让出后能保留会话 400px 与右栏 300px，才允许让出这条轨道。
 if(rightbarCanShow(viewportWidth,false,RIGHTBAR_MIN))return false
 return directoryOpen
}

/** 原型 platform-preview.css：≤1450px 打开群侧栏时会话目录让位。 */
export const GROUP_PANEL_DIRECTORY_MAX_VIEWPORT=1450

/** 正在并栏展开、可能占用目录轨道的面板。普通会话右栏与群侧栏不会同屏。 */
export type DirectoryOccupants={rightbar:boolean;groupPanel:boolean}

/**
 * 目录此刻是否绘制。让位只在渲染期派生，不改写本人的 directoryOpen：
 * 面板收起或窗口放宽后原目录自动回来。
 */
export function directoryShown(viewportWidth:number,directoryOpen:boolean,occupants:DirectoryOccupants):boolean{
 if(!directoryOpen)return false
 if(occupants.rightbar&&!rightbarDirectoryForOpening(viewportWidth,true))return false
 // 740px 及以下目录是本人打开的覆盖层，不随群侧栏让位。
 return !(occupants.groupPanel&&viewportWidth>RIGHTBAR_FULL_WIDTH_MAX_VIEWPORT&&viewportWidth<=GROUP_PANEL_DIRECTORY_MAX_VIEWPORT)
}

/** 群页上报群侧栏展开状态后的当前展开群：按群身份撤回，旧群迟到的关闭不能覆盖新群。 */
export function groupPanelReport(current:string|undefined,groupId:string,open:boolean):string|undefined{
 return open?groupId:current===groupId?undefined:current
}

/** 本人主动要看目录时，是否须先收起占位面板；收起只隐藏面板，页签、草稿与偏好保留。 */
export function directoryNeedsRoom(viewportWidth:number,occupants:DirectoryOccupants):boolean{
 return !directoryShown(viewportWidth,true,occupants)
}

/** 仅通过公开导航接口收起本会话右栏，页签与草稿保留；其他会话的右栏不受影响。 */
export function collapseRightbarForDirectory(face:Pick<ISidebarRight,'mounted'|'isExpanded'|'toggleExpanded'>|undefined,sessionId:string|undefined):boolean{
 if(!face||!sessionId||face.mounted.getSnapshot()!==sessionId||!face.isExpanded())return false
 face.toggleExpanded()
 return true
}

/** 固定 DSH 在 768px 以下自动全屏且跳过 canShow；桌面概况只能保留入口并收起。 */
export function canShowConversationOverview(viewportWidth:number,canShow=true):boolean{return viewportWidth>=768&&canShow}

/** 仅通过公开导航接口收起当前概况，不关闭页签，也不修改原生展示模式。 */
export function collapseOverviewWithoutRoom(face:Pick<ISidebarRight,'mounted'|'active'|'isExpanded'|'toggleExpanded'>|undefined,sessionId:string|undefined,viewportWidth:number,canShow:boolean):boolean{
 if(!face||!sessionId||canShowConversationOverview(viewportWidth,canShow)||face.mounted.getSnapshot()!==sessionId||face.active()?.kind!=='teloa.overview'||!face.isExpanded())return false
 face.toggleExpanded()
 return true
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
