const copy={
 foreign:['这条请求属于另一位员工，请返回原员工核对。','這條請求屬於另一位員工，請返回原員工核對。','This request belongs to another employee. Return to that employee to review it.'],
 unknown:['暂时无法核实这条请求属于哪位员工，请先核对原请求。','暫時無法核實這條請求屬於哪位員工，請先核對原請求。','The employee for this request could not be verified. Review the original request before continuing.'],
} as const
export function permissionPendingCopy(locale:string,key:keyof typeof copy){
 return copy[key][/^zh-(hant|tw|hk)$/i.test(locale)?1:/^zh(?:-(?:hans|cn))?$/i.test(locale)?0:2]
}
