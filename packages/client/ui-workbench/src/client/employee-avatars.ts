import {ROLE_AVATAR_SHAPES,ROLE_AVATAR_COLORS,roleAvatarKeyOf,type RoleAvatarShape,type RoleAvatarColor} from '@teloa/contract'
import {botAvatarParts} from './bot-avatar.js'
/** 员工头像的形状与颜色名称（简体 / 繁体 / 英文）；图形见 bot-avatar.ts，取值规则见契约 role-avatars.mjs。 */
const shapeNames:Record<RoleAvatarShape,readonly [string,string,string]>={
 circle:['圆','圓','Circle'],pebble:['卵石','卵石','Pebble'],star4:['四角星','四角星','Four-point star'],cloud:['云朵','雲朵','Cloud'],
 drop:['水滴','水滴','Drop'],squircle:['圆角方块','圓角方塊','Squircle'],bean:['豆形','豆形','Bean'],flower:['花瓣','花瓣','Petal'],
 softtri:['软三角','軟三角','Soft triangle'],capsule:['胶囊','膠囊','Capsule'],ghost:['小幽灵','小幽靈','Little ghost'],hexa:['软六边','軟六邊','Soft hexagon']
}
const colorNames:Record<RoleAvatarColor,readonly [string,string,string]>={
 terracotta:['陶土','陶土','Terracotta'],orange:['橙','橙','Orange'],amber:['琥珀','琥珀','Amber'],olive:['橄榄绿','橄欖綠','Olive'],teal:['青绿','青綠','Teal'],
 mist:['雾蓝','霧藍','Mist blue'],indigo:['靛蓝','靛藍','Indigo'],plum:['梅紫','梅紫','Plum'],warmgray:['暖灰','暖灰','Warm gray']
}
const index=(locale:string)=>locale==='zh-CN'?0:locale.startsWith('zh')?1:2
export const avatarShapes=ROLE_AVATAR_SHAPES,avatarColors=ROLE_AVATAR_COLORS,avatarKeyOf=roleAvatarKeyOf
/** 当前取值的形状与颜色；未设置或无法识别时为通用形象（圆 × 暖灰），与渲染回退一致。 */
export const avatarChoice=botAvatarParts
export const avatarShapeName=(shape:RoleAvatarShape,locale:string)=>shapeNames[shape][index(locale)]
export const avatarColorName=(color:RoleAvatarColor,locale:string)=>colorNames[color][index(locale)]
/** 头像说明「颜色 · 形状」；预设键与组合键按同一外观描述。 */
export function employeeAvatarName(key:string|undefined,locale:string){
 const {shape,color}=avatarChoice(key)
 return `${avatarColorName(color,locale)} · ${avatarShapeName(shape,locale)}`
}
