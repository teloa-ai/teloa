/** 已确认目录方案的简繁英文案；其他语言使用英文回退。 */
const copy={
 sort:['排序','排序','Sort'],name:['姓名','姓名','Name'],duty:['岗位','職位','Role'],business:['所属业务','所屬業務','Business'],current:['状态与当前工作','狀態與目前工作','Status and current work'],contact:['联系','聯絡','Contact'],phone:['语音通话','語音通話','Voice call'],
 preferences:['日常偏好','日常偏好','Preferences'],models:['模型与服务','模型與服務','Models and services'],connections:['能力与连接','能力與連接','Capabilities and connections'],work:['工作方式','工作方式','Working style'],advanced:['高级','進階','Advanced'],about:['关于','關於','About'],
 create:['描述目标新建','描述目標建立','Create from a goal'],rules:['规则管理','規則管理','Manage rules'],goalTitle:['你想让员工持续做什么？','你想讓員工持續做什麼？','What should your employee keep doing?'],
 goalHint:['先描述目标，再确认员工、执行时间与通知方式。','先描述目標，再確認員工、執行時間與通知方式。','Describe the goal, then confirm the employee, schedule and notifications.'],
 goalLabel:['持续工作目标','持續工作目標','Ongoing work goal'],goalPlaceholder:['例如：整理客户反馈，标记紧急问题，并给我一份摘要。','例如：整理客戶回饋，標記緊急問題，並給我一份摘要。','For example: summarize customer feedback and flag urgent issues.'],
 continue:['继续设置','繼續設定','Continue setup'],scheduleNotice:['描述会填入工作目标。执行时间需下一步确认；保存后保持暂停，不自动执行。','描述會填入工作目標。執行時間需下一步確認；儲存後保持暫停，不會自動執行。','Your description becomes the goal. Confirm the schedule next; saved rules stay paused until enabled.'],
 conversationCreate:['在会话中创建','在會話中建立','Create in a conversation'],manualCreate:['按表单创建','使用表單建立','Create with a form'],
 conversationHint:['说清做什么、多久一次；在会话里补充和调整。','說明要做什麼、多久一次；在會話裡補充和調整。','Describe the work and frequency; refine it in the conversation.'],
 conversationNotice:['先带入原会话，发送后才创建；新计划保持暂停。','先帶入原會話，傳送後才建立；新計劃保持暫停。','Prepare the original conversation first. New plans stay paused.'],
 preparingConversation:['正在准备会话…','正在準備會話…','Preparing conversation…'],savedPlans:['已保存计划','已儲存計劃','Saved plans'],allPlans:['查看全部','查看全部','View all'],
 taskCount:['共 {count} 项任务','共 {count} 項任務','{count} tasks'],
 executionInfo:['执行信息','執行資訊','Execution details'],viewPlans:['查看计划','查看計劃','View plans'],planFilters:['筛选计划','篩選計劃','Filter plans'],
} as const
export function directoryChoiceCopy(locale:string,key:keyof typeof copy){return copy[key][locale==='zh-CN'?0:locale.startsWith('zh')?1:2]}
