import {officialExtensionPackages,roleWriteDefinition,readPageCreateAtomicSkillDraft,type PageCreateDraftDirectory,type PageCreateDraftPreview,type PageCreateEntity} from '@teloa/contract'

/** 传输编码留在契约中，用户核对的是入口正文和附件名称。 */
export function createReadableFields(preview:PageCreateDraftPreview):PageCreateDraftPreview['fields']{
 if(preview.draft.entity!=='skill')return preview.fields
 try{
  const draft=readPageCreateAtomicSkillDraft(JSON.parse(preview.draft.body))
  const metadata=preview.fields.filter(field=>!field.path.startsWith('files'))
  return [...metadata,...draft.files.map(file=>({path:file.path,value:file.path==='SKILL.md'?new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(file.base64),character=>character.charCodeAt(0))):`${atob(file.base64).length} B`}))]
 }catch{return preview.fields.filter(field=>!field.path.endsWith('.base64'))}
}
import type {TeloaTranslate} from './i18n/index.js'

/**
 * 页内新建入口的判断层：三选可用性、草案行、确认闸、失败文案、一句话的预备文本全在这里，
 * 组件本身不做判断。分两处的理由与 `business-home-presentation.ts` 一样——这些判据要能
 * 单独回归，摆在组件里就只能靠渲染出来的字符串反推。
 */
export type CreateOption='sentence'|'form'|'market'

/**
 * 业务台账「再加一类业务」的范围键：与 `industry-loads.ts`/`content-store.ts` 认的同一条
 * ASCII 短名规则（不能是中文，也不能靠显示名顶替）。判据摆在这里而不是组件里，
 * 好让「不合规就不渲染 `CreateEntry`」与「显示名恰好合规时顺手填一份短名」两处都能单独回归。
 */
const businessDomainScopeKeyPattern=/^[a-zA-Z0-9_-]{1,64}$/
export function businessDomainScopeKeyValid(value:string):boolean{return businessDomainScopeKeyPattern.test(value)}
/**
 * 显示名与范围键分两个输入框：用户没有手动改过范围键、且显示名本身恰好合规时，顺手替他填一份，
 * 仍可再改；中文名或带空格的名字不合规，不做拼音或其他转写，返回 `undefined` 表示不改动范围键。
 */
export function businessDomainAutoShortName(name:string,shortNameTouched:boolean):string|undefined{
 if(shortNameTouched||!businessDomainScopeKeyValid(name))return undefined
 return name
}

const placeholderKeys={
 'business-definition':'create.sentence.placeholder.business',
 'business-domain':'create.sentence.placeholder.business',
 role:'create.sentence.placeholder.role',
 skill:'create.sentence.placeholder.skill',
 connector:'create.sentence.placeholder.connector',
 extension:'create.sentence.placeholder.extension',
} as const

/** 一句话预备进会话时要点名的实体名词，按 entity 取，六类各一条。 */
const entityNameKeys={
 'business-definition':'create.entity.businessDefinition',
 'business-domain':'create.entity.businessDomain',
 role:'create.entity.role',
 skill:'create.entity.skill',
 connector:'create.entity.connector',
 extension:'create.entity.extension',
} as const

const consequenceKeys={
 permission:'create.consequence.permission',
 egress:'create.consequence.egress',
 credential:'create.consequence.credential',
 impact:'create.consequence.impact',
} as const

const draftStatusKeys={
 draft:'create.draft.pending',
 applied:'create.draft.applied',
 discarded:'create.draft.discarded',
} as const

const nextKeys={
 role:'create.next.role',skill:'create.next.skill',connector:'create.next.connector',
 extension:'create.next.extension','business-domain':'create.next.businessDomain','business-definition':'create.next.businessDefinition',
} as const
/** 给用户的是既有步骤名称，端点名仍仅供调用方核对落点。 */
export function createNextKey(entity:PageCreateEntity):typeof nextKeys[PageCreateEntity]{return nextKeys[entity]}

/**
 * 三选里哪几项可用：业务台账首页与扩展没有「自己填」（那两处今天没有手填表单，规格 §七），
 * 扩展那一支的「用一句话描述」还要有官方包白名单才有落点——白名单空了这一项就不出现，
 * 不摆一颗必然只能回「一个都没匹配到」的按钮。
 */
export function createOptions({entity,hasForm,hasMarket}:{entity:PageCreateEntity;hasForm:boolean;hasMarket:boolean}):CreateOption[]{
 const options:CreateOption[]=[]
 if(entity!=='extension'||officialExtensionPackages.length>0)options.push('sentence')
 if(hasForm&&entity!=='business-domain'&&entity!=='extension')options.push('form')
 if(hasMarket)options.push('market')
 return options
}

/** 一句话输入框的占位文案按实体取：业务两支共用一条（两支都是「记一类东西」那件事）。 */
export function createPlaceholderKey(entity:PageCreateEntity):typeof placeholderKeys[PageCreateEntity]{
 return placeholderKeys[entity]
}

/** 一句话预备进会话时，点名要建哪一类实体所用的名词键，六类各一条。 */
export function createEntityNameKey(entity:PageCreateEntity):typeof entityNameKeys[PageCreateEntity]{
 return entityNameKeys[entity]
}

/** 「会带来什么」四类各自那一句：回包只回 kind 与标识，文案由这里选，不拼正文（规格 §五第 5 条）。 */
export function createConsequenceKey(kind:PageCreateDraftPreview['consequences'][number]['kind']):typeof consequenceKeys[PageCreateDraftPreview['consequences'][number]['kind']]{
 return consequenceKeys[kind]
}

/**
 * 目录里的每一行：标题逐字取草案自带的摘要（不翻译），状态词条按 `status` 选。
 * `pending` 就是「还没建」——草案行存在不等于实体存在（规格 §五第 3 条），界面据此决定摆不摆确认。
 */
export function createDraftRows(directory:PageCreateDraftDirectory):Array<{draftId:string;titleKey:typeof draftStatusKeys[keyof typeof draftStatusKeys];title:string;pending:boolean}>{
 return directory.drafts.map(draft=>({draftId:draft.id,titleKey:draftStatusKeys[draft.status],title:draft.title,pending:draft.status==='draft'}))
}

/**
 * 确认闸：预览没读到就没有确认（规格 §五第 2 条），已经落定过的草案也没有。
 * 返回的 `expectedBodyHash` 与 `next` 逐字取预览回包，调用方不得自己算一份——
 * 自己算就等于绕开了「预览之后被改过的草案不能被当成已落地」这道判据。
 */
export function createConfirmGuard(preview:PageCreateDraftPreview|undefined):{ok:true;expectedBodyHash:string;next:string}|{ok:false;reason:'not-previewed'|'already-settled'}{
 if(preview===undefined)return {ok:false,reason:'not-previewed'}
 if(preview.draft.status!=='draft')return {ok:false,reason:'already-settled'}
 return {ok:true,expectedBodyHash:preview.draft.bodyHash,next:preview.next.endpoint}
}

/**
 * 读写草案失败时该说哪一句。按错误码选一条固定文案键，认不出来的码退回通用那句，
 * 不把内部错误码、原始 message 或 `details` 摆到界面上（与 `businessLedgerFailureKey` 同一条）。
 */
export function createFailureKey(error:unknown):'create.readFailed'|'create.conflict'|'create.forbidden'{
 const code=error!==null&&typeof error==='object'&&'code' in error?String((error as {code:unknown}).code):''
 if(code==='teloa/version-conflict'||code==='teloa/conflict')return 'create.conflict'
 if(code==='teloa/forbidden')return 'create.forbidden'
 return 'create.readFailed'
}

/**
 * 一句话 → 预备进会话的那一条（D3）：三行固定文案 + 用户原话逐字。
 * 第一行点名要建哪一类实体（隔离宿主实跑发现模型不知道要建哪一类，工具名不写进提示——
 * 模型工具描述里已有）；第二行按有没有 scope 分别说明业务范围或不需要业务范围；
 * 第三行沿用既有前缀，再换行接用户原话。`sourceId` 是 `entity:scope` 复合键，`sourceKind`
 * 缺省——因此 `prompt-preparation.ts` 与 `PreparedPromptCard.tsx` 一行不改。任何标识都不拼进
 * 模型可改写的位置：那句话里只有固定文案与原话。
 *
 * `displayName` 只有业务台账新增业务范围那一支会传：范围键是给模型调用工具用的 ASCII 短名，
 * 显示名才是本人写下的业务名称；两者都要点名，并交代清单 `title` 取显示名，
 * 避免模型把范围键误当成清单标题回填。
 */
export function createSentencePrompt(entity:PageCreateEntity,scope:string|undefined,sentence:string,t:TeloaTranslate,displayName?:string):{sourceId:string;title:string;text:string}{
 const text=sentence.trim()
 if(!text)throw Error('这句话是空的，没有可预备的内容。')
 const entityLine=t('create.sentence.prompt.entity',{entity:t(createEntityNameKey(entity))})
 const scopeLine=scope===undefined?t('create.sentence.prompt.noScope'):displayName===undefined?t('create.sentence.prompt.scope',{scope}):t('create.sentence.prompt.scopeWithName',{scope,name:displayName})
 const lines=[entityLine,scopeLine,t('create.sentence.prompt')]
 // 技能首行是官方 /名称 显式调用手势：宿主在本人普通会话里注入固定版本的内置创建器正文，保存草案时再核对它确实在上下文中。
 if(entity==='skill')lines.unshift('/teloa-skill-creator')
 return {sourceId:entity+':'+(scope??''),title:t('create.title'),text:lines.join('\n')+'\n'+text}
}

/**
 * 数字员工草案进入既有三问表单前再走一次岗位写入判据。
 * 预览回包本身已经经过宿主校验；这里仍重新读取，避免客户端把错误实体或被篡改的正文作为表单初值。
 */
export function createRoleFormInitial(preview:PageCreateDraftPreview){
 if(preview.draft.entity!=='role')throw Error('这份草案不能用于新建员工。')
 let body:unknown
 try{body=JSON.parse(preview.draft.body)}catch{throw Error('员工草案正文无法读取。')}
 return roleWriteDefinition(body)
}
