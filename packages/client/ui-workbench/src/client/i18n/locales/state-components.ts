// B8 共享状态组件（toast 回执、读取三态、危险确认）的通用文案。简中、繁中、英文定稿，其余语言回退英文，待成熟版本统一补译。
type Values=readonly [string,string,string,string,string,string,string,string,string,string]
type Row<K extends string=string>=readonly [K,...Values]
const fallback=<K extends string>(key:K,cn:string,tw:string,en:string):Row<K>=>[key,cn,tw,en,en,en,en,en,en,en,en]

export const STATE_COMPONENT_MESSAGE_ROWS=[
 fallback('toast.close','关闭通知','關閉通知','Dismiss notification'),
 fallback('readState.slow','读取较慢，仍在尝试…','讀取較慢，仍在嘗試…','Taking longer than usual. Still trying…'),
 fallback('readState.elapsed','已用 {seconds} 秒','已用 {seconds} 秒','{seconds}s elapsed'),
 fallback('readState.cancel','取消','取消','Cancel'),
 fallback('readState.failedTitle','没能读取{subject}','無法讀取{subject}','Couldn’t load {subject}'),
 fallback('readState.timeout','{seconds} 秒内没有响应，其他内容不受影响。','{seconds} 秒內沒有回應，其他內容不受影響。','No response within {seconds} seconds. Nothing else is affected.'),
 fallback('readState.retry','重试','重試','Retry'),
 fallback('readState.back','返回','返回','Back'),
 fallback('readState.cancelled','已取消读取{subject}','已取消讀取{subject}','Stopped loading {subject}'),
 fallback('readState.reload','重新读取','重新讀取','Load again'),
 fallback('dangerConfirm.typeName','输入名称「{name}」确认','輸入名稱「{name}」確認','Type “{name}” to confirm'),
 fallback('dangerConfirm.cancel','取消','取消','Cancel'),
] as const
