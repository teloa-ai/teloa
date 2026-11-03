const rows=[
 ['rework.title','继续已修改的任务','繼續已修改的任務','Continue the updated task'],
 ['rework.boundary','保留本任务与历史执行，按已保存的新目标回到待准备；不会立即执行。','保留本任務與歷史執行，按已儲存的新目標回到待準備；不會立即執行。','Keep this task and its run history, and return the saved new goal to preparation. This does not execute it.'],
 ['rework.action','按已修改目标继续','按已修改目標繼續','Continue with the updated goal'],
 ['rework.check','核对原继续请求','核對原繼續請求','Check the original continuation request'],
 ['rework.loading','正在核对任务与本轮控制…','正在核對任務與本輪控制…','Checking the task and its round control…'],
 ['rework.resume','恢复本轮后再准备','恢復本輪後再準備','Resume this round before preparing'],
 ['rework.resumeBody','本轮当前已暂停。确认只恢复本轮控制，不启动旧执行；随后仍需你准备并确认新执行。','本輪目前已暫停。確認只恢復本輪控制，不啟動舊執行；隨後仍需你準備並確認新執行。','This round is paused. Confirm to resume its control without starting an old run. You will still prepare and confirm the next run.'],
 ['rework.resumeConfirm','确认恢复本轮控制','確認恢復本輪控制','Confirm resuming this round'],
 ['rework.controlBlocked','本轮控制尚不能准备，请核对工作状态后重试。','本輪控制尚不能準備，請核對工作狀態後重試。','This round is not ready for preparation. Check the work state and try again.'],
 ['rework.retry','重新核对','重新核對','Check again'],
 ['workOutstanding','请先停止本轮工作，结束后再取消任务。','請先停止本輪工作，結束後再取消任務。','Stop this run before cancelling the task.'],
 ['verificationWaiting.title','本轮交付仍待核验','本輪交付仍待核驗','This delivery is still awaiting verification'],
 ['verificationWaiting.description','自动结项条件尚未全部满足。核对运行、来源和正式成果；未收尾或结果未知的工作不会自动通过。','自動結項條件尚未全部滿足。核對執行、來源與正式成果；未收尾或結果未知的工作不會自動通過。','The automatic completion conditions are not yet all satisfied. Check the run, sources, and saved output. Unsettled work or unknown results cannot pass automatically.'],
] as const
export type TaskCompletionMessageKey=`taskCompletion.${typeof rows[number][0]}`
export const TASK_COMPLETION_MESSAGE_KEYS=rows.map(row=>`taskCompletion.${row[0]}` as TaskCompletionMessageKey)
const column=(index:1|2|3)=>Object.fromEntries(rows.map(row=>[`taskCompletion.${row[0]}`,row[index]])) as Readonly<Record<TaskCompletionMessageKey,string>>
export const taskCompletionMessages={'zh-CN':column(1),'zh-Hant':column(2),en:column(3)}
