import clsx from 'clsx'
import type {RoleAvatarKey} from '@teloa/contract'
import {employeeAvatar} from './employee-avatars.js'
import type {StaffAvatarSize} from './StaffAvatar.js'
import css from './StaffAvatar.module.css'
/** 员工形象只来自内置素材；旧身份稳定回退通用形象。 */
export function EmployeeAvatar({avatarKey,size='md'}:{avatarKey?:RoleAvatarKey|undefined;size?:StaffAvatarSize}){
 return <span className={clsx(css.avatarWrap,css['size'+size])} aria-hidden="true"><img src={employeeAvatar(avatarKey).src} className={css.squirrel} alt=""/></span>
}
