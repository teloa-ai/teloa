const zh={manager:'检索管理',unknown:'原操作结果未知，请先核对，不要重复操作。',manage:'管理资料',waiting:'正在等待操作回执…',attention:(count:number)=>`${count} 份资料需要核对，请展开管理查看。`}
const hant:typeof zh={manager:'檢索管理',unknown:'原操作結果未知，請先核對，不要重複操作。',manage:'管理資料',waiting:'正在等候操作回執…',attention:count=>`${count} 份資料需要核對，請展開管理查看。`}
const en:typeof zh={manager:'Retrieval management',unknown:'The original operation result is unknown. Review it before repeating the action.',manage:'Manage materials',waiting:'Waiting for the operation receipt…',attention:count=>`${count} materials need review. Open management to check them.`}
export function libraryRetrievalCopy(locale:string){return /^zh-(hant|tw|hk)$/i.test(locale)?hant:/^zh(?:-(hans|cn))?$/i.test(locale)?zh:en}
