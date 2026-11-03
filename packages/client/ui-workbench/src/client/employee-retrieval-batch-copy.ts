const zh={
 progress:(from:number,to:number,total:number,remaining:number)=>`当前显示 ${from}–${to} / ${total} 份资料。${remaining?`后续 ${remaining} 份尚未发送，刷新后需重新选择。`:''}`,
 title:(name:string)=>name?`${name} · 批量加入检索`:'批量加入检索',cancel:'取消剩余项目',cancelling:'已停止后续加入，等待在途回执',running:'正在加入资料',done:'本次处理结果',review:'核对原操作结果',reviewing:'正在核对…',
 boundary:'取消不移除已加入的资料，也不停止后台索引。',unknown:'请求未正常完成，结果待核对；后续项目未自动发送。核对仅读取当前登记，不重发加入请求。',model:'本地检索模型尚未就绪，本次未发送加入请求。',restored:'已恢复原批次记录，没有重新发送加入请求。',storage:'批次恢复记录无法读取或保存。请检查浏览器存储后刷新，并核对原操作；暂不发送新批次。',
 summary:(n:Record<string,number>)=>`已加入 ${n.added} · 已登记 ${n.present} · 失败 ${n.failed} · 待核对 ${n.unknown} · 已取消 ${n.cancelled} · 未处理 ${n.unattempted} · 不可用 ${n.unavailable}`,
 states:{queued:'等待加入',sending:'等待原操作回执',added:'已加入',present:'已登记（当前状态已核对）',failed:'加入失败',unknown:'请求异常，结果待核对',cancelled:'已取消，未发送',unattempted:'未处理，未发送',unavailable:'资料不可用，未发送'},
}
const hant:typeof zh={
 progress:(from,to,total,remaining)=>`目前顯示 ${from}–${to} / ${total} 份資料。${remaining?`後續 ${remaining} 份尚未傳送，重新整理後須重新選擇。`:''}`,
 title:name=>name?`${name} · 批量加入檢索`:'批量加入檢索',cancel:'取消剩餘項目',cancelling:'已停止後續加入，等候進行中的操作回覆',running:'正在加入資料',done:'本次處理結果',review:'核對原操作結果',reviewing:'正在核對…',
 boundary:'取消不會移除已加入的資料，也不會停止背景索引。',unknown:'請求未正常完成，結果待核對；後續項目未自動傳送。核對只讀取目前登記，不會重新傳送加入請求。',model:'本機檢索模型尚未就緒，本次未傳送加入請求。',restored:'已復原原批次記錄，沒有重新傳送加入請求。',storage:'無法讀取或儲存批次復原記錄。請檢查瀏覽器儲存空間後重新整理，並核對原操作；暫不傳送新批次。',
 summary:n=>`已加入 ${n.added} · 已登記 ${n.present} · 失敗 ${n.failed} · 待核對 ${n.unknown} · 已取消 ${n.cancelled} · 未處理 ${n.unattempted} · 不可用 ${n.unavailable}`,
 states:{queued:'等候加入',sending:'等候原操作回覆',added:'已加入',present:'已登記（目前狀態已核對）',failed:'加入失敗',unknown:'請求異常，結果待核對',cancelled:'已取消，未傳送',unattempted:'未處理，未傳送',unavailable:'資料不可用，未傳送'},
}
const en:typeof zh={
 progress:(from,to,total,remaining)=>`Showing ${from}–${to} of ${total} materials.${remaining?` ${remaining} later items have not been sent; select them again after reloading.`:''}`,
 title:name=>name?`${name} · Add materials to retrieval`:'Add materials to retrieval',cancel:'Cancel remaining items',cancelling:'Remaining items cancelled; waiting for the in-flight response',running:'Adding materials',done:'Batch results',review:'Review original operation',reviewing:'Reviewing…',
 boundary:'Cancelling keeps added materials and does not stop background indexing.',unknown:'The request did not complete normally. Its result needs review; later items were not sent automatically. Review reads current registrations without resending the request.',model:'The local retrieval model is not ready. No enrollment requests were sent.',restored:'The original batch record was restored. No enrollment requests were resent.',storage:'The batch recovery record could not be read or saved. Check browser storage, reload, and review the original operation before sending another batch.',
 summary:n=>`Added ${n.added} · Registered ${n.present} · Failed ${n.failed} · Needs review ${n.unknown} · Cancelled ${n.cancelled} · Not processed ${n.unattempted} · Unavailable ${n.unavailable}`,
 states:{queued:'Queued',sending:'Waiting for original response',added:'Added',present:'Registered (current state verified)',failed:'Enrollment failed',unknown:'Request error; result needs review',cancelled:'Cancelled; not sent',unattempted:'Not processed; not sent',unavailable:'Material unavailable; not sent'},
}
export const employeeRetrievalBatchCopy=(locale:string)=>/^zh-(hant|tw|hk)$/i.test(locale)?hant:/^zh(?:-(hans|cn))?$/i.test(locale)?zh:en
