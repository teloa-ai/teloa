import {ROLE_AVATAR_KEYS,ROLE_AVATAR_SHAPES,ROLE_AVATAR_COLORS} from '@teloa/contract'
/** 头像取值由契约最终核验；工具参数不放 136 项枚举，读回的组合值可原样作为 expectedProfile。 */
export const roleAvatarDescription=`Teloa内置员工头像：预设键（${ROLE_AVATAR_KEYS.join('|')}）或自由组合 bot:<形状>:<颜色>，形状 ${ROLE_AVATAR_SHAPES.join('|')}，颜色 ${ROLE_AVATAR_COLORS.join('|')}。修改资料时原样沿用读到的值；不要使用URL或自定义凭据。`
