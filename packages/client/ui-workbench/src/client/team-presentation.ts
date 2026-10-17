import type {TeloaTranslate} from './i18n/index.js'

const key=(value:string)=>value as Parameters<TeloaTranslate>[0]

export function roleMemoryPath(status:'candidate'|'confirmed'|'withdrawn',t?:TeloaTranslate){
  if(t)return {label:t(key(`team.presentation.memory.${status}.label`)),summary:t(key(`team.presentation.memory.${status}.summary`)),next:t(key(`team.presentation.memory.${status}.next`))}
  if(status==='candidate')return {label:'待本人核对',summary:'来源已记录，核对后才可进入员工范围。',next:'核对候选内容'}
  if(status==='confirmed')return {label:'已核对',summary:'来源与范围相容时，只进入新 Run 的锁定输入，不授予资料或执行权限。',next:'查看适用范围'}
  return {label:'已撤回',summary:'已撤回，不再作为员工参考；历史与来源保留。',next:'查看撤回记录'}
}

/** 「本人反馈」来源的标题由服务端以中文固定写入（backend work/role-memory.ts）；按来源类别显示当前语言，其余来源原样显示。 */
export function roleMemorySourceTitle(memory:{source:{kind:string};sourceTitle:string},t:TeloaTranslate):string{
  return memory.source.kind==='self-feedback'?t(key('team.memory.selfFeedback')):memory.sourceTitle
}

export function roleLifecyclePath(state:'active'|'paused'|'retired',t?:TeloaTranslate){
  if(t)return {label:t(key(`team.presentation.lifecycle.${state}.label`)),summary:t(key(`team.presentation.lifecycle.${state}.summary`)),next:t(key(`team.presentation.lifecycle.${state}.next`))}
  if(state==='paused')return {label:'暂停接收新工作',summary:'不再接收新交办与后续触发；已开始工作可收尾，外部操作需单独核对。',next:'核对已在途工作'}
  if(state==='retired')return {label:'停止新交办',summary:'保留身份、历史和既有引用；未完成工作需要逐项交接。',next:'安排未完成工作交接'}
  return {label:'接收获准的新工作',summary:'员工可接收符合业务范围的交办；外部操作仍按任务单独核验。',next:'查看当前工作'}
}

export function roleWorkPath(persistent:boolean,t?:TeloaTranslate){
  return t?t(persistent?'team.presentation.work.persistent':'team.presentation.work.demo'):persistent?'保存后前往任务页，核对目标与依据并开始执行。':'这是页面示例交办，不会启动 Agent 或外部操作。'
}

export function roleSkillNotice(t?:TeloaTranslate){
  return t?t('team.presentation.skillNotice'):'技能是可复用方法，不是执行任务的必经路由。没有现成技能时，员工可在沙箱和既有权限内自主解决；只有缺少资料、密钥、外部权限或越过风险边界时才需要回流或委派。'
}

/**
 * 分身在界面上显示的名字按本人用户名拼（原型 原型.jsx:459 的「Max 的分身」），
 * 不显示存储里的 `role.name`——示例值是第一人称的「我的分身」，出现在同事名单里读不通。
 * 账号块入口仍用第一人称的 navigation.twin，不走这里。
 */
export function twinDisplayName(profileName:string,t?:TeloaTranslate):string{
  const name=profileName.trim()
  return t?t('team.twin.displayName',{name}):`${name} 的分身`
}

/**
 * 分身内置默认的职责、可读资料与执行范围由服务端以中文写入（backend work/roles.ts personalTwinFields），存量数据不迁移。
 * 仅当分身字段仍逐字等于该原文时显示当前语言的默认文案；本人改过的文字原样显示，存储与回传值不变。
 */
const personalTwinDefaults={
  duty:'按本人确认的偏好整理资料、代拟回复和判断建议。正式批准由本人完成。',
  dataScope:'本人可见且明确提供的资料；私人偏好不自动共享。',
  executionScope:'仅代拟；不能代批、冒充本人或直接外发。',
} as const
export type TwinDefaultField=keyof typeof personalTwinDefaults
export function roleFieldText(role:{kind:string}&Readonly<Record<TwinDefaultField,string>>,field:TwinDefaultField,t:TeloaTranslate):string{
  const value=role[field]
  return role.kind==='twin'&&value===personalTwinDefaults[field]?t(key(`team.twin.default.${field}`)):value
}

// 目录分区行与个人主页身份栏此前各写一份同样的四档状态映射；抽成一处，两边共用同一口径（team.roster.status.*）。
export function roleStatusLabel(value:'active'|'busy'|'paused'|'retired',t?:TeloaTranslate):string{
  const messageKey={active:'team.roster.status.active',busy:'team.roster.status.busy',paused:'team.roster.status.paused',retired:'team.roster.status.retired'} as const
  if(t)return t(key(messageKey[value]))
  return {active:'在岗',busy:'有待办',paused:'先歇一会',retired:'已离职'}[value]
}
