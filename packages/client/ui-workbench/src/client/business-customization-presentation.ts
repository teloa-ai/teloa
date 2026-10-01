import type {BusinessCustomizationDirectory,BusinessCustomizationEntry,BusinessDefinitionPreview,BusinessLedgerBlock} from '@teloa/contract'
export type CustomizationDraftRow={draftId:string;kindKey:typeof kindKeys[keyof typeof kindKeys];localId:string;semver:string;pending:boolean}
export type CustomizationRevertTarget={kind:'local-version';version:number}|{kind:'template'}
export type CustomizationRevertOption={target:CustomizationRevertTarget;labelKey:'business.custom.revert.version'|'business.custom.revert.template';version?:number}

const kindKeys={
 'object-type':'business.custom.kind.objectType',
 view:'business.custom.kind.view',
 action:'business.custom.kind.action',
 'source-mapping':'business.custom.kind.sourceMapping',
 widget:'business.custom.kind.widget',
 dashboard:'business.custom.kind.dashboard',
} as const

/** 草案状态只在这一处翻译为面板行，组件不再自行猜 kind 与可确认状态。 */
export function customizationDraftRows(directory:BusinessCustomizationDirectory):CustomizationDraftRow[]{
 return directory.drafts.map(draft=>({draftId:draft.id,kindKey:kindKeys[draft.kind],localId:draft.localId,semver:draft.semver,pending:draft.status==='draft'}))
}

/**
 * 确认必须针对预览时看到的当前版本。只要目录已指向另一份声明，就宁可要求重新预览，
 * 不用旧预览推断服务端会如何处理。
 */
export function customizationApplyGuard(preview:BusinessDefinitionPreview,entry:BusinessCustomizationEntry|undefined):{ok:true;expectedDefinitionHash:string;expectedCurrentVersion:number}|{ok:false;reason:'stale-preview'|'already-applied'}{
 if(preview.draft.status==='applied')return {ok:false,reason:'already-applied'}
 const current=entry?.current
 if(preview.base.origin==='local'){
  if(!current||current.definitionHash!==preview.base.definitionHash)return {ok:false,reason:'stale-preview'}
 }else if(preview.base.origin==='template'){
  // 模板是基准时，本地指针必须仍为空；否则同一 localId 已被别的确认改写。
  if(current)return {ok:false,reason:'stale-preview'}
 }else if(current)return {ok:false,reason:'stale-preview'}
 return {ok:true,expectedDefinitionHash:preview.draft.definitionHash,expectedCurrentVersion:current?.version??0}
}

/** 当前版本已经生效时不提供“回到自己”的伪操作；模板不存在时不提供不可完成的回退。 */
export function customizationRevertOptions(entry:BusinessCustomizationEntry):CustomizationRevertOption[]{
 const versions=entry.versions
  .filter(version=>version.version!==entry.current?.version)
  .map(version=>({target:{kind:'local-version' as const,version:version.version},labelKey:'business.custom.revert.version' as const,version:version.version}))
 return entry.template.available&&entry.current
  ? [...versions,{target:{kind:'template' as const},labelKey:'business.custom.revert.template' as const}]
  : versions
}

/** 来源由服务端逐字给出；对象类型或任一视图本地化，都必须让块明确标记。 */
export function blockLocalCustomized(block:BusinessLedgerBlock):boolean{
 return block.objectType.source.origin==='local'||block.views.some(view=>view.origin==='local')
}

export type CustomizationFailure={key:'business.custom.readFailed'|'business.custom.conflict'|'business.custom.forbidden'|'business.custom.invalidDraft'|'business.custom.invalidRequest';params?:{reason:string}}
/**
 * 错误详情不进入组件；界面只从白名单错误码选可操作的固定文案。
 * 唯一例外是 `teloa/invalid-input`：服务端 reason 截 200 个码点随词条带上屏，由调用方作 React 文本子节点渲染。
 * 其中带 `details.crossReference===true` 的是草案本身与已有定义对不上（`invalidDraft`），其余 invalid-input 用通用原因句（`invalidRequest`）。
 */
export function customizationFailureKey(error:unknown):CustomizationFailure{
 const row=error!==null&&typeof error==='object'?error as {code?:unknown;message?:unknown;details?:unknown}:{}
 const code=typeof row.code==='string'?row.code:''
 if(code==='teloa/forbidden')return {key:'business.custom.forbidden'}
 if(code==='teloa/version-conflict'||code==='teloa/conflict')return {key:'business.custom.conflict'}
 if(code==='teloa/invalid-input'){
  const reason=Array.from(typeof row.message==='string'?row.message:'').slice(0,200).join('')
  const crossReference=row.details!==null&&typeof row.details==='object'&&(row.details as {crossReference?:unknown}).crossReference===true
  return {key:crossReference?'business.custom.invalidDraft':'business.custom.invalidRequest',params:{reason}}
 }
 return {key:'business.custom.readFailed'}
}
