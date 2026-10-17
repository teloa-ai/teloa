import {useEffect,useState} from 'react'
import {KeyRound} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {skillSecretsBadge,type SkillSecretsState} from './skill-secrets-api.js'
import {useI18n} from './i18n/provider.js'

/** 只读声明与配置状态；密钥值仍只由原设置表单写入，不预取或回显。 */
export function SkillSecretsBadgeButton({skill,title,describe,open,iconOnly=false}:{skill:string;title:string;describe:((skill:string)=>Promise<SkillSecretsState>)|undefined;open:(skill:string,title:string)=>void;iconOnly?:boolean}){
 const {t}=useI18n(),[state,setState]=useState<SkillSecretsState>()
 useEffect(()=>{let active=true;setState(undefined);void describe?.(skill).then(value=>{if(active&&value.skill===skill)setState(value)},()=>{});return()=>{active=false}},[describe,skill])
 const label=state?skillSecretsBadge(state,t):t('market.skillSecrets.open')
 return iconOnly?<ToolbarIconButton label={title+' · '+label} icon={KeyRound} onClick={()=>open(skill,title)}/>:<button type="button" onClick={()=>open(skill,title)}>{label}</button>
}
