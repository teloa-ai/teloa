const rows=[
 ['verificationWaiting.title','本轮交付仍待核验','本輪交付仍待核驗','This delivery is still awaiting verification'],
 ['verificationWaiting.description','自动结项条件尚未全部满足。核对运行、来源和正式成果；未收尾或结果未知的工作不会自动通过。','自動結項條件尚未全部滿足。核對執行、來源與正式成果；未收尾或結果未知的工作不會自動通過。','The automatic completion conditions are not yet all satisfied. Check the run, sources, and saved output. Unsettled work or unknown results cannot pass automatically.'],
] as const
export type TaskCompletionMessageKey=`taskCompletion.${typeof rows[number][0]}`
export const TASK_COMPLETION_MESSAGE_KEYS=rows.map(row=>`taskCompletion.${row[0]}` as TaskCompletionMessageKey)
const column=(index:1|2|3)=>Object.fromEntries(rows.map(row=>[`taskCompletion.${row[0]}`,row[index]])) as Readonly<Record<TaskCompletionMessageKey,string>>
export const taskCompletionMessages={'zh-CN':column(1),'zh-Hant':column(2),en:column(3)}
