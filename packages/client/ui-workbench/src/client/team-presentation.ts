import type {TeloaTranslate} from './i18n/index.js'

const key=(value:string)=>value as Parameters<TeloaTranslate>[0]

export function roleMemoryPath(status:'candidate'|'confirmed'|'withdrawn',t?:TeloaTranslate){
  if(t)return {label:t(key(`team.presentation.memory.${status}.label`)),summary:t(key(`team.presentation.memory.${status}.summary`)),next:t(key(`team.presentation.memory.${status}.next`))}
  if(status==='candidate')return {label:'待本人核对',summary:'来源已记录，核对后才可进入员工范围。',next:'核对候选内容'}
  if(status==='confirmed')return {label:'已核对',summary:'来源与范围相容时，只进入新 Run 的锁定输入，不授予资料或执行权限。',next:'查看适用范围'}
  return {label:'已撤回',summary:'已撤回，不再作为员工参考；历史与来源保留。',next:'查看撤回记录'}
}

export function roleLifecyclePath(state:'active'|'paused'|'retired',t?:TeloaTranslate){
  if(t)return {label:t(key(`team.presentation.lifecycle.${state}.label`)),summary:t(key(`team.presentation.lifecycle.${state}.summary`)),next:t(key(`team.presentation.lifecycle.${state}.next`))}
  if(state==='paused')return {label:'暂停接收新工作',summary:'不再接收新交办与后续触发；已开始工作可收尾，外部操作需单独核对。',next:'核对已在途工作'}
  if(state==='retired')return {label:'停止新交办',summary:'保留身份、历史和既有引用；未完成工作需要逐项交接。',next:'安排未完成工作交接'}
  return {label:'接收获准的新工作',summary:'员工可接收符合业务范围的交办；外部操作仍按任务单独核验。',next:'查看当前工作'}
}

export function roleWorkPath(persistent:boolean,t?:TeloaTranslate){
  return t?t(persistent?'team.presentation.work.persistent':'team.presentation.work.demo'):persistent?'已保存交办，等待执行接入；交办本身不启动 Agent。':'这是页面示例交办，不会启动 Agent 或外部操作。'
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

// 目录分区行与个人主页身份栏此前各写一份同样的四档状态映射；抽成一处，两边共用同一口径（team.roster.status.*）。
export function roleStatusLabel(value:'active'|'busy'|'paused'|'retired',t?:TeloaTranslate):string{
  const messageKey={active:'team.roster.status.active',busy:'team.roster.status.busy',paused:'team.roster.status.paused',retired:'team.roster.status.retired'} as const
  if(t)return t(key(messageKey[value]))
  return {active:'在岗',busy:'有待办',paused:'先歇一会',retired:'已离职'}[value]
}
