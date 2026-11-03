import {useEffect,useRef,useState} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import {CustomMcpAppManager} from './CustomMcpAppEntry.js'
import {hasCustomMcpAppApi,type ManagedMcpConnectionApi,type ManagedMcpConnectionRecord} from './mcp-connections-api.js'
import {useI18n} from './i18n/provider.js'

type Props={catalogId:string;api:ManagedMcpConnectionApi|undefined;close:()=>void}
type Read={api:Props['api'];catalogId:string;record?:ManagedMcpConnectionRecord;failed?:true}
/** 自定义 catalogId 只定位本人已保存的连接；打开设置不创建、授权或连接服务。 */
export function CustomMcpConnectionRoute({catalogId,api,close}:Props){
 const {t}=useI18n(),origin=useRef({catalogId,api}).current,[read,setRead]=useState<Read>(),[retry,setRetry]=useState(0)
 const changed=origin.api!==api||origin.catalogId!==catalogId
 useEffect(()=>{
  let active=true
  if(changed||!api||!hasCustomMcpAppApi(api)||typeof api.list!=='function'){setRead({api,catalogId,failed:true});return}
  void api.list().then(rows=>{
   const matches=rows.filter(row=>row.catalogId===catalogId&&row.custom&&row.catalogId==='custom.'+row.serverName)
   const record=matches.length===1?matches[0]:undefined
   if(active)setRead(record?{api,catalogId,record}:{api,catalogId,failed:true})
  },()=>{if(active)setRead({api,catalogId,failed:true})})
  return()=>{active=false}
 },[api,catalogId,changed,retry])
 const current=!changed&&read&&read.api===api&&read.catalogId===catalogId?read:undefined
 if(current?.record&&api&&hasCustomMcpAppApi(api))return <CustomMcpAppManager api={api} id={current.record.id} title={current.record.custom?.title??current.record.serverName} close={close}/>
 return <ContextDrawer open title={t('create.entity.app')} close={close}>
  {changed||current?.failed?<><p role="alert">{t('create.readFailed')}</p><button type="button" onClick={()=>{setRead(undefined);setRetry(value=>value+1)}}>{t('create.app.retry')}</button></>:<p role="status">{t('create.preview.loading')}</p>}
 </ContextDrawer>
}
