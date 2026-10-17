import {BookOpen,Braces,FileText,Link2,Package,Palette,Presentation,Search,ShieldCheck,Workflow} from 'lucide-react'
import {useState} from 'react'
import {resourceBrands,resourceAvatars,type ResourceBrand} from './resource-icon-assets.js'
import {employeeAvatar} from './employee-avatars.js'
import type {RoleAvatarKey} from '@teloa/contract'
import css from './ResourceIcon.module.css'

const aliases:Record<string,ResourceBrand>={'googleworkspace':'google','gdrive':'google-drive','googledrive':'google-drive','googlesheets':'google-sheets','googleslides':'google-slides','chatgpt':'openai','claudecode':'claude','notionremote':'notion'}
const token=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'')
/** 仅按完整产品标识识别，避免标题里的普通单词误套第三方品牌。 */
export function resourceBrand(id:string,title:string):keyof typeof resourceBrands|undefined{
 const server=id.match(/(?:^|:)mcp__(.+?)__/)?.[1]
 const leaf=id.split(/[.:/]/).at(-1)??id
 const parts=[title,server??leaf]
 return Object.keys(resourceBrands).find(key=>parts.some(part=>token(part)===token(key)||aliases[token(part)]===key)) as keyof typeof resourceBrands|undefined
}
function avatarFor(title:string):keyof typeof resourceAvatars{
 if(/设计|designer|design/i.test(title))return 'ui-designer'
 if(/研究|research/i.test(title))return 'researcher'
 if(/开发|工程|developer|engineer/i.test(title))return 'developer'
 if(/营销|运营|marketing/i.test(title))return 'marketing'
 if(/销售|sales/i.test(title))return 'sales'
 if(/人力|招聘|recruit|human resource/i.test(title))return 'hr'
 if(/财务|財務|finance|account/i.test(title))return 'finance'
 if(/项目|project/i.test(title))return 'project'
 if(/写作|文案|writer/i.test(title))return 'content-writer'
 if(/安全|security/i.test(title))return 'security-analyst'
 return 'general'
}
export function ResourceIcon({kind,id,title,avatarKey,brandKey,size=44}:{kind:string;id:string;title:string;avatarKey?:RoleAvatarKey|undefined;brandKey?:ResourceBrand|null|undefined;size?:40|44|52|undefined}){
 const [failed,setFailed]=useState<string>()
 const role=kind==='agent'||kind==='role'
 // null 明确禁用标题推断：本机自建同名技能不能冒用第三方品牌。
 const brand=role||brandKey===null?undefined:brandKey??resourceBrand(id,title)
 const image=role?(avatarKey?employeeAvatar(avatarKey).src:resourceAvatars[avatarFor(title)]):brand?resourceBrands[brand]:undefined
 const Icon=/research|研究|调研/i.test(title)?Search:/ppt|演示|presentation/i.test(title)?Presentation:/pdf|文档|document/i.test(title)?FileText:/design|设计/i.test(title)?Palette:/security|安全/i.test(title)?ShieldCheck:kind==='source'||kind==='connector'||kind==='mcp'||kind==='data-source'?Link2:kind==='skill'?Braces:kind==='method'||kind==='work-template'?Workflow:kind==='knowledge'?BookOpen:Package
 return <span className={`${css.icon} ${role?css.avatar:brand?css.brand:css[kind]??css.skill}`} style={{width:size,height:size}} aria-hidden="true">{image&&failed!==image?<img src={image} alt="" onError={()=>setFailed(image)}/>:<Icon size={size/2}/>}</span>
}
