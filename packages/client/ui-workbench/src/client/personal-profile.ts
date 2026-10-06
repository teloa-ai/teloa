import {applicationPresentation} from './application-presentation.ts'
export type PersonalProfile={displayName:string;email?:string;managed?:true}

const key='teloa.personal-profile/v1'
export const defaultPersonalDisplayName=''

function usableName(value:string):string{
  const name=value.normalize('NFC').trim().replace(/\s+/gu,' ')
  return /[@＠\p{Cc}]/u.test(name)||!/\p{L}/u.test(name)?'':name
}

/** 姓名用于展示；邮箱只在账号设置中核对，不从邮箱推导本人姓名。 */
export function personalDisplayName(value:string,fallback:string):string{
  return usableName(value)||fallback
}

const graphemes=new Intl.Segmenter('und',{granularity:'grapheme'})
/** 取姓名首尾词的首个完整字素，单名只取一个；跳过装饰符号及标点。 */
export function personalAvatarInitials(value:string):string{
  const words=usableName(value).split(' ').filter(word=>/\p{L}/u.test(word))
  const initial=(word:string)=>[...graphemes.segment(word)].find(part=>/\p{L}/u.test(part.segment))?.segment.toUpperCase()??''
  if(!words.length)return ''
  return initial(words[0]!)+(words.length>1?initial(words.at(-1)!):'')
}

export function normalizePersonalDisplayName(value:string):string{
  const name=value.trim().replace(/\s+/g,' ')
  if(!name)throw Error('用户名不能为空。')
  if(/[@＠]/u.test(name))throw Error('显示名称不能使用邮箱。')
  if(!usableName(name))throw Error('用户名不能为空。')
  if([...name].length>40)throw Error('用户名不能超过 40 个字符。')
  return name.normalize('NFC')
}

function read():PersonalProfile{
  const account=applicationPresentation.getSnapshot().account
  if(account)return {...account,displayName:usableName(account.displayName),managed:true}
  if(typeof window==='undefined')return {displayName:defaultPersonalDisplayName}
  try{
    const value=JSON.parse(window.localStorage.getItem(key)??'null') as unknown
    if(value&&typeof value==='object'&&Object.keys(value).length===1&&typeof Reflect.get(value,'displayName')==='string')return {displayName:normalizePersonalDisplayName(Reflect.get(value,'displayName') as string)}
  }catch{}
  return {displayName:defaultPersonalDisplayName}
}

let snapshot=read()
const listeners=new Set<()=>void>()
const refresh=()=>{const next=read();if(next.displayName===snapshot.displayName)return;snapshot=next;for(const listener of listeners)listener()}
applicationPresentation.subscribe(()=>{snapshot=read();for(const listener of listeners)listener()})

export const personalProfile={
  subscribe(listener:()=>void){
    listeners.add(listener)
    if(listeners.size===1&&typeof window!=='undefined')window.addEventListener('storage',refresh)
    return ()=>{listeners.delete(listener);if(!listeners.size&&typeof window!=='undefined')window.removeEventListener('storage',refresh)}
  },
  getSnapshot:()=>snapshot,
  setDisplayName(value:string){
    if(applicationPresentation.getSnapshot().account)throw Error('账号姓名由账号服务管理。')
    const displayName=normalizePersonalDisplayName(value)
    if(typeof window!=='undefined')window.localStorage.setItem(key,JSON.stringify({displayName}))
    if(displayName===snapshot.displayName)return
    snapshot={displayName}
    for(const listener of listeners)listener()
  },
}
