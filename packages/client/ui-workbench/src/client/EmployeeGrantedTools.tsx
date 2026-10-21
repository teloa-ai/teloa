import {useEffect,useState} from 'react'
import {Wrench} from 'lucide-react'
import type {PreviewRole} from './role-preview.js'
import type {RoleToolGrantApi} from './role-tool-grant-api.js'
import {roleToolLabel} from './RoleToolGrants.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TeamPage.module.css'

/** 主页只读已经生效的授权；完整范围、版本核对和明确保存仍在原授权组件里。 */
export function EmployeeGrantedTools({role,api,open}:{role:PreviewRole;api?:RoleToolGrantApi|undefined;open:()=>void}){
 const {t,locale}=useI18n(),key=role.id+':'+role.version
 const [read,setRead]=useState<{api:RoleToolGrantApi;key:string;row?:Awaited<ReturnType<RoleToolGrantApi['get']>>;error?:string}>()
 const current=read&&read.api===api&&read.key===key?read:undefined,row=current?.row,error=current?.error
 useEffect(()=>{let live=true;if(!api||role.storage!=='persistent')return;void api.get(role.id).then(row=>{if(live)setRead({api,key,row})},error=>{if(live)setRead({api,key,error:localizeWorkError(locale,error)})});return()=>{live=false}},[api,key,role.storage,locale])
 return error?<p role="alert">{error}</p>:row?<div className={css.resourceChips}>{row.grant?.state==='active'?Array.from(new Set(row.grant.rules.map(rule=>rule.name))).map(name=><button type="button" key={name} onClick={open}><Wrench size={13}/>{roleToolLabel(name,t)}</button>):<p className={css.muted}>{t('roleGrant.none')}</p>}</div>:api&&role.storage==='persistent'?<p role="status" className={css.muted}>{t('roleGrant.loading')}</p>:null
}
