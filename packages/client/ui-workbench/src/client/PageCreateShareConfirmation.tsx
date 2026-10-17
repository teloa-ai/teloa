import {useEffect,useMemo,useRef,useState} from 'react'
import {WorkError,type PageCreateDraftPreview,type TemplateShareReceipt} from '@teloa/contract'
import {ShareDraftDrawer,useTemplateShare} from './EmployeeTemplateShare.js'
import {readSharePackage,sharePackageDigest} from './share-package-plan.js'
import type {PageCreateApi} from './page-create-api.js'
import {useI18n} from './i18n/provider.js'

export type PageCreateShareConfirmationProps={
 preview:PageCreateDraftPreview
 apply:(shareId:string)=>Promise<void>
 api:Pick<PageCreateApi,'read'>
 confirmed?:(shareId:string)=>void|Promise<void>
}
const changed=()=>Object.assign(Error('共享草案或发布来源已变化。'),{code:'share-changed'})
const cancelled=()=>new WorkError('teloa/cancelled','原共享预览已关闭。')

/** 只接原分享journal及真实回执；预览、导出和复制均不落定页内草案。 */
export function PageCreateShareConfirmation(props:PageCreateShareConfirmationProps){
 const shared=useTemplateShare(),source=JSON.stringify([props.preview.draft.id,props.preview.draft.entity,props.preview.draft.scope,props.preview.draft.bodyHash,props.preview.draft.body])
 const origin=useRef({source,api:props.api,storage:shared?.storage,bridge:shared?.bridge,key:0})
 if(origin.current.source!==source||origin.current.api!==props.api||origin.current.storage!==shared?.storage||origin.current.bridge!==shared?.bridge)origin.current={source,api:props.api,storage:shared?.storage,bridge:shared?.bridge,key:origin.current.key+1}
 return <ShareConfirmation key={origin.current.key} {...props}/>
}
function ShareConfirmation({preview,apply,api,confirmed}:PageCreateShareConfirmationProps){
 const {t}=useI18n(),shared=useTemplateShare(),[open,setOpen]=useState(false),openRef=useRef(open);openRef.current=open
 const lifetime=useRef<AbortController>()
 useEffect(()=>{const current=new AbortController();lifetime.current=current;return()=>current.abort()},[])
 const pkg=useMemo(()=>{
  try{
   if(preview.draft.entity!=='share'||preview.draft.status!=='draft')return undefined
   const body:unknown=JSON.parse(preview.draft.body)
   if(typeof body!=='object'||body===null||Array.isArray(body)||Object.keys(body).length!==1||!('package'in body))return undefined
   return readSharePackage(body.package)
  }catch{return undefined}
 },[preview.draft.body,preview.draft.entity,preview.draft.status])
 const current=()=>lifetime.current!==undefined&&!lifetime.current.signal.aborted&&openRef.current
 const onPublished=async(receipt:TemplateShareReceipt)=>{
  const controller=lifetime.current
  if(!pkg||!controller||!current())throw cancelled()
  const digest=await sharePackageDigest(pkg)
  if(controller!==lifetime.current||!current())throw cancelled()
  if(receipt.revoked||receipt.version!==pkg.version||receipt.sha256!==digest||typeof receipt.shareId!=='string'||!receipt.shareId.trim())throw changed()
  const saved=await api.read({draftId:preview.draft.id},controller.signal)
  if(controller!==lifetime.current||!current())throw cancelled()
  if(saved.id!==preview.draft.id||saved.ownerId!==preview.draft.ownerId||saved.entity!=='share'||saved.scope!==preview.draft.scope||saved.bodyHash!==preview.draft.bodyHash)throw changed()
  if(saved.status==='applied'){
   if(saved.appliedRef!==receipt.shareId)throw changed()
  }else{
   if(saved.status!=='draft')throw changed()
   await apply(receipt.shareId)
  }
  if(controller!==lifetime.current||!current())return
  await confirmed?.(receipt.shareId)
  if(controller===lifetime.current&&current())setOpen(false)
 }
 if(!pkg)return <p role="alert">{t('create.conflict')}</p>
 if(!shared)return <p role="status">{t('templateShare.offline')}</p>
 return <><button type="button" onClick={()=>setOpen(true)}>{t('templateShare.previewShare')}</button><ShareDraftDrawer pkg={pkg} open={open} close={()=>setOpen(false)} editable={false} onPublished={onPublished}/></>
}
