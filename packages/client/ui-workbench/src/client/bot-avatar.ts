import {roleAvatarParts,type RoleAvatarKey,type RoleAvatarShape,type RoleAvatarColor} from '@teloa/contract'
/**
 * 1.0 员工头像：形状 × 颜色的小机器人（viewBox 0 0 64 64，一个形状 + 两只眼睛 + 一处高光）。
 * 形状与色板逐字移植自 Claude Design「1.0-员工头像系统」的 avatar-kit.js；全部落在以 (32,32) 为圆心、半径 29 的圆内。
 */
export const botShapes:Record<RoleAvatarShape,{d:string;eye:number;hl:readonly [number,number,number];soft?:true}>={
 circle:{d:'M32 6a26 26 0 1 1 0 52a26 26 0 1 1 0-52z',eye:31,hl:[22,18,-30]},
 pebble:{d:'M33 8c13 0 24 9 24 23c0 15-11 25-25 25C17 56 7 46 7 32C7 17 19 8 33 8z',eye:31,hl:[21,19,-30]},
 star4:{d:'M32 6C35 20 44 29 58 32C44 35 35 44 32 58C29 44 20 35 6 32C20 29 29 20 32 6z',eye:31,hl:[27,24,-50],soft:true},
 cloud:{d:'M19 51c-8 0-14-6-14-13c0-7 5-12 11-13c1-9 8-15 17-15c8 0 14 5 16 12c6 1 11 7 11 13c0 9-7 16-15 16z',eye:36,hl:[25,20,-20]},
 drop:{d:'M32 5c10 12 22 22 22 35c0 11-10 19-22 19S10 51 10 40C10 27 22 17 32 5z',eye:41,hl:[27,24,-55]},
 squircle:{d:'M32 7c18 0 25 7 25 25s-7 25-25 25S7 50 7 32S14 7 32 7z',eye:31,hl:[20,18,-30]},
 bean:{d:'M23 10c8-3 13 3 19 4c9 2 16 8 16 18c0 14-12 24-26 24C17 56 8 47 8 34c0-11 7-21 15-24z',eye:33,hl:[19,22,-40]},
 flower:{d:'M32 7c7 0 11 5 12 11c6 1 12 6 12 14s-6 13-12 14c-1 6-5 11-12 11s-11-5-12-11c-6-1-12-6-12-14s6-13 12-14c1-6 5-11 12-11z',eye:32,hl:[25,16,-20]},
 softtri:{d:'M32 8c4 0 7 3 10 8l15 26c4 8-1 14-9 14H16c-8 0-13-6-9-14l15-26c3-5 6-8 10-8z',eye:39,hl:[28,20,-60]},
 capsule:{d:'M20 15h24c9 0 17 8 17 17s-8 17-17 17H20C11 49 3 41 3 32s8-17 17-17z',eye:32,hl:[15,23,-15]},
 ghost:{d:'M32 6c13 0 23 10 23 23v19c0 4-4 6-7 3l-3-3-4 4c-2 2-5 2-7 0l-2-2-2 2c-2 2-5 2-7 0l-4-4-3 3c-3 3-7 1-7-3V29C9 16 19 6 32 6z',eye:29,hl:[21,16,-30]},
 hexa:{d:'M27 7c3-2 7-2 10 0l15 9c3 2 5 5 5 9v14c0 4-2 7-5 9l-15 9c-3 2-7 2-10 0l-15-9c-3-2-5-5-5-9V25c0-4 2-7 5-9z',eye:32,hl:[19,20,-30]}
}
/** 员工色板（形状、颜色与 28 款预设的对照表在契约 role-avatars.mjs）；墨黑只留给 Teloa 主助手（深色界面看不清），普通员工不用。 */
export const botColors:Record<RoleAvatarColor,string>={terracotta:'#B5583B',orange:'#D9772E',amber:'#C99A22',olive:'#76863A',teal:'#2F877B',mist:'#6A8BA6',indigo:'#4A55A0',plum:'#8A4E86',warmgray:'#8A8278'}
type BotPaint={shape:RoleAvatarShape;fill:string;eye:string}
/** 预设键与 `bot:<shape>:<color>` 都按形状 × 颜色绘制；未设置或无法识别的值（如更新版本的新形状）稳定回退通用形象。 */
export const botAvatarParts=(key?:string)=>roleAvatarParts(key)??roleAvatarParts('general')!
export const botAvatarPaint=(key?:string):BotPaint=>{const {shape,color}=botAvatarParts(key);return {shape,fill:botColors[color],eye:'#FFFFFF'}}
/** Teloa 主助手固定墨黑四角星；颜色走主题令牌，深色界面换成 #E9ECE4 与墨黑眼睛。 */
export const teloaBotPaint:BotPaint={shape:'star4',fill:'var(--teloa-bot-ink)',eye:'var(--teloa-bot-ink-eye)'}
/** 生成独立 SVG 标记，供只能使用图片地址的位置（如资源图标）；颜色须是具体色值。 */
export function botAvatarMarkup({shape,fill,eye}:BotPaint){
 const s=botShapes[shape],[x,y,r]=s.hl
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="${s.d}" fill="${fill}"${s.soft?` stroke="${fill}" stroke-width="5" stroke-linejoin="round"`:''}/><ellipse cx="${x}" cy="${y}" rx="6" ry="3" transform="rotate(${r} ${x} ${y})" fill="#FFFFFF" fill-opacity="0.28"/><ellipse cx="26" cy="${s.eye}" rx="3" ry="3.8" fill="${eye}"/><ellipse cx="38" cy="${s.eye}" rx="3" ry="3.8" fill="${eye}"/></svg>`
}
export const botAvatarUri=(key?:RoleAvatarKey)=>'data:image/svg+xml,'+encodeURIComponent(botAvatarMarkup(botAvatarPaint(key)))
