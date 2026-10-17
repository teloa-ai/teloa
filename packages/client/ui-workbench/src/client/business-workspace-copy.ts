const copy={
 staffCount:['{count} 位员工','{count} 位員工','{count} employees'],
 generalStaff:['{count} 位在岗员工，可以一起协作','{count} 位在職員工，可以一起協作','{count} active employees ready to collaborate'],generalNoStaff:['暂无在岗员工','暫無在職員工','No active employees'],generalDescription:['资料、任务、项目与协作群，都能围绕你的目标展开。','資料、任務、專案與協作群，都能圍繞你的目標展開。','Work with your team on files, tasks, projects and shared goals.'],
 newConversation:['另建会话','另建對話','New conversation'],
 coordinator:['协调员工','協調員工','Coordinator'],unavailable:['当前不可交办','目前不可交辦','Unavailable for dispatch'],configureCoordinator:['设置协调员工','設定協調員工','Set coordinator'],coordinatorHint:['协调由同一位员工兼任。此设置也用作新工作的默认负责员工，不改变已交办工作。','由同一位員工兼任協調。此設定亦用作新工作的預設負責員工，不更改已交辦工作。','An existing employee coordinates the team and becomes the default assignee for new work. Existing work stays assigned.'],

 overview:['总览','總覽','Overview'],data:['业务内容','業務內容','Records'],dashboards:['统计看板','統計看板','Dashboards'],employees:['AI 员工','AI 員工','AI employees'],groups:['协作群','協作群','Groups'],projects:['项目','專案','Projects'],
 subtitle:['员工持续处理工作，你掌握进展与关键决定。','員工持續處理工作，你掌握進度與關鍵決定。','Your team keeps working. Follow progress and make key decisions.'],
 start:['开始工作','開始工作','Start work'],createGroup:['发起协作群','發起協作群','Create group'],configure:['业务设置','業務設定','Business settings'],
 current:['正在推进','正在推進','In progress'],attention:['需要你处理','需要你處理','Needs you'],completed:['已完成工作','已完成工作','Completed work'],active:['在岗员工','在職員工','Active employees'],
 progress:['员工工作进展','員工工作進度','Team progress'],work:['当前工作','目前工作','Current work'],history:['完成记录','完成記錄','Completed work'],
 emptyWork:['还没有进行中的工作','還沒有進行中的工作','No work in progress'],emptyWorkHint:['提出目标、补充资料，就能开始；也可以从业务内容中交办工作。','提出目標、補充資料，就能開始；也可以從業務內容中交辦工作。','Describe a goal and add context to start, or dispatch work from a record.'],
 emptyAttention:['暂时没有需要你处理的事项','暫時沒有需要你處理的事項','Nothing needs your attention'],emptyStaff:['还没有参与这项业务的员工','還沒有參與這項業務的員工','No employees assigned to this business'],manageStaff:['管理员工','管理員工','Manage employees'],
 emptyGroups:['还没有协作群','還沒有協作群','No groups yet'],groupHint:['为同一目标组群，共用平台里的员工、消息与资料。','為同一目標組群，共用平台中的員工、訊息與資料。','Bring the same platform employees together with shared messages and context.'],
 idle:['暂无进行中的工作','暫無進行中的工作','No work in progress'],noWork:['无进行中工作','無進行中工作','No active work'],workCount:['{count} 项','{count} 項','{count} active'],talk:['对话','對話','Chat'],paused:['暂停','暫停','Paused'],working:['在岗','在職','Active'],
 loading:['正在读取…','正在讀取…','Loading…'],failed:['读取失败，请重试','讀取失敗，請重試','Unable to load. Try again.'],retry:['重试','重試','Retry'],all:['查看全部','查看全部','View all'],refresh:['刷新','重新整理','Refresh'],
 dashboardEmpty:['尚未配置统计看板','尚未設定統計看板','No dashboards configured'],dashboardHint:['配置后，已保存的业务结果会按指标口径汇总到这里。','設定後，已儲存的業務結果會按指標定義彙總到這裡。','Once configured, saved business results are aggregated by your metric definitions.'],prepareDashboard:['配置看板','設定看板','Configure dashboard'],
 task:['工作','工作','Work'],employee:['负责人','負責人','Assignee'],state:['状态','狀態','Status'],updated:['最近更新','最近更新','Updated'],unassigned:['待分派','待指派','Unassigned'],
} as const
export function businessWorkspaceText(locale:string,key:keyof typeof copy){return copy[key][locale.startsWith('zh')?(/Hant|TW|HK/i.test(locale)?1:0):2]}
