const messages={
 open:['返回原交办','返回原交辦','Return to original request'],
 boundary:['这项工作来自原会话交办，请返回原交办卡核对或重试。返回会话不会自动开始执行。','這項工作來自原對話交辦，請返回原交辦卡核對或重試。返回對話不會自動開始執行。','This work belongs to the original conversation request. Review or retry from that card. Returning does not start execution.'],
 stopped:['原交办已停止。可以返回原会话核对记录，不会自动继续。','原交辦已停止。可以返回原對話核對紀錄，不會自動繼續。','The original request is stopped. Return to review its records; work will not resume automatically.'],
 unavailable:['暂时无法核对原交办来源，请重试。原任务、失败记录和输入均保留。','暫時無法核對原交辦來源，請再試一次。原工作、失敗紀錄和輸入均保留。','Could not verify the original request. Try again. The task, failed run and input are preserved.'],
 config:['请返回原交办核对运行配置，再从原交办卡重试。','請返回原交辦核對執行設定，再從原交辦卡重試。','Review the run configuration and retry from the original request card.'],
} as const
export const taskRunOriginCopy=(locale:string,key:keyof typeof messages)=>messages[key][locale==='zh-CN'?0:locale.startsWith('zh')?1:2]
export function requiresOriginalTaskRequest(error:unknown):boolean{
 if(!error||typeof error!=='object'||!('code' in error)||error.code!=='teloa/conflict'||!('details' in error)||!error.details||typeof error.details!=='object')return false
 return 'reason' in error.details&&error.details.reason==='conversation-work-parent'
}
