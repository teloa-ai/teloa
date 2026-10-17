import {WorkError} from './work-error.ts'

/** 展示姓名不是认证身份，也不从邮箱推导；群模型面与界面共用此规范化。 */
export function usablePersonalName(value:string):string{
 const name=value.normalize('NFC').trim().replace(/\s+/gu,' ')
 return /[@＠\p{Cc}]/u.test(name)||!/\p{L}/u.test(name)?'':name
}

export type PersonalDisplayProfile={displayName:string}
export function readPersonalDisplayProfile(value:unknown):PersonalDisplayProfile{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!('displayName' in value)||typeof value.displayName!=='string')throw new WorkError('teloa/invalid-input','个人资料格式不正确。')
 const displayName=value.displayName
 if(displayName!==''&&(usablePersonalName(displayName)!==displayName||[...displayName].length>40))throw new WorkError('teloa/invalid-input','显示名称须为有效姓名，不能使用邮箱。')
 return {displayName}
}
