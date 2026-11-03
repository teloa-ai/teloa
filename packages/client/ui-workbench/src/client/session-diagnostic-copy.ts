type Key='download'|'cancel'|'description'|'saved'|'incomplete'|'cancelled'|'failed'|'missing'|'forbidden'
const messages:Record<'zh-CN'|'zh-Hant'|'en',Record<Key,string>>={
 'zh-CN':{
  download:'下载诊断副本',cancel:'取消诊断下载',description:'仅保存脱敏事件元数据到本机，不自动上传。正文、推理、工具参数和结果、路径及附件正文均省略。完整会话 ZIP 仍保留原始内容和附件。',saved:'诊断副本已下载，可先检查后再分享。',incomplete:'已下载不完整的诊断副本，限制或失败说明见文件末尾。',cancelled:'诊断下载已取消。',failed:'诊断副本暂时无法下载，请重试。',missing:'原会话已不可用，无法下载诊断副本。',forbidden:'当前连接无权下载此会话的诊断副本。',
 },
 'zh-Hant':{
  download:'下載診斷副本',cancel:'取消診斷下載',description:'只將去除敏感內容的事件中繼資料儲存到本機，不會自動上傳。對話內容、推理、工具參數及結果、路徑與附件內容均省略。完整對話 ZIP 仍保留原始內容與附件。',saved:'診斷副本已下載，可先檢查再分享。',incomplete:'已下載不完整的診斷副本，限制或失敗說明請見檔案結尾。',cancelled:'已取消診斷下載。',failed:'暫時無法下載診斷副本，請重試。',missing:'原對話已無法使用，無法下載診斷副本。',forbidden:'目前的連線無權下載此對話的診斷副本。',
 },
 en:{
  download:'Download diagnostic copy',cancel:'Cancel diagnostic download',description:'Saves redacted event metadata locally without uploading it. Message bodies, reasoning, tool arguments and results, paths and attachment contents are omitted. The full session ZIP keeps original content and attachments.',saved:'Diagnostic copy downloaded. Review it before sharing.',incomplete:'An incomplete diagnostic copy was downloaded. See its final record for limits or failures.',cancelled:'Diagnostic download cancelled.',failed:'The diagnostic copy could not be downloaded. Try again.',missing:'The original session is unavailable for diagnostic download.',forbidden:'This connection cannot download diagnostics for that session.',
 },
}
export function sessionDiagnosticCopy(locale:string,key:Key):string{return messages[locale==='zh-CN'?'zh-CN':/^zh(?:-|$)/i.test(locale)?'zh-Hant':'en'][key]}
