/** 详情页分层呈现的有界三语文案与判定：只决定首屏显示多少，不改变任何字段、状态或动作。 */
const rows={
 goalExpand:['展开全文','展開全文','Show full goal'],
 goalCollapse:['收起','收合','Show less'],
 properties:['属性','屬性','Properties'],
 planMore:['更多信息','更多資訊','More details'],
 planMoreAria:['计划的版本、来源与调度健康','計畫的版本、來源與排程健康','Plan version, source, and schedule health'],
} as const
export type DetailDensityKey=keyof typeof rows
export function detailDensityCopy(locale:string,key:DetailDensityKey):string{return rows[key][locale==='zh-Hant'?1:locale.startsWith('zh')?0:2]}

/** 长目标阈值：超过这些就先显示前几行并提供展开；原文始终完整保留在页面里。 */
export const longTextChars=180,longTextLines=4
export function isLongDetailText(text:string):boolean{return text.length>longTextChars||text.split('\n').length>longTextLines}

/** 无可执行动作的终态（取消、完成且没有待办）不再显示与页头重复的大状态卡；审批、失败、等待输入等仍走状态卡。 */
export function quietTerminalStatus(input:{state:string;needs:readonly string[];hasControl:boolean;hasAttention:boolean}):boolean{
 return (input.state==='cancelled'||input.state==='completed')&&input.needs.length===0&&!input.hasControl&&!input.hasAttention
}
