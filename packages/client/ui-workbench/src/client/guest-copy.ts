import type {ProductLocale} from './i18n/locale.js'

const en={
 account:'Account',closeSettings:'Close settings',
 login:'Log in',guest:'Guest',title:'What would you like to work on?',prompt:'What would you like to accomplish?',placeholder:'Describe your goal, ask a question, or start a project…',start:'Start working',hint:'Your work runs on this Mac.',emptyPrompt:'Describe what you would like to accomplish first.',failed:'Unable to continue. Please try again.',waiting:'Opening…',
 description:{attention:'Log in to review requests that need your attention.',messages:'Log in to continue your conversations.',tasks:'Log in to view your tasks, progress, and results.',projects:'Log in to view your projects and related work.',plans:'Log in to create and manage your automations.',team:'Log in to work with your AI employees.',spaces:'Log in to view and build your business workspace.',resources:'Log in to add and use your reference materials.',capabilities:'Skills and tools help Teloa complete your work. Log in to manage your capabilities.',market:'Discover solutions and resources for your work. Log in to browse and add them.',settings:'Set up models and connections in your workspace after you log in.'},
} as const
const zh={
 account:'账号',closeSettings:'关闭设置',
 login:'登录',guest:'访客',title:'今天想完成什么？',prompt:'想完成什么工作？',placeholder:'描述你的目标、提出问题，或开始一个项目…',start:'开始工作',hint:'工作在这台 Mac 上执行。',emptyPrompt:'请先描述你想完成的工作。',failed:'暂时无法继续，请重试。',waiting:'正在打开…',
 description:{attention:'登录后处理需要你确认的工作。',messages:'登录后继续你的对话。',tasks:'登录后查看你的任务、进度和成果。',projects:'登录后查看你的项目和相关工作。',plans:'登录后创建和管理你的自动化。',team:'登录后与你的 AI 员工一起工作。',spaces:'登录后查看和搭建你的业务工作区。',resources:'登录后添加和使用你的参考资料。',capabilities:'技能与工具帮助 Teloa 完成工作。登录后管理你的能力。',market:'发现适合你的方案与资源，登录后浏览和添加。',settings:'登录后在工作台中设置模型与连接。'},
} as const
const zhHant={
 account:'帳號',closeSettings:'關閉設定',
 login:'登入',guest:'訪客',title:'今天想完成什麼？',prompt:'想完成什麼工作？',placeholder:'描述你的目標、提出問題，或開始一個專案…',start:'開始工作',hint:'工作在這台 Mac 上執行。',emptyPrompt:'請先描述你想完成的工作。',failed:'暫時無法繼續，請重試。',waiting:'正在開啟…',
 description:{attention:'登入後處理需要你確認的工作。',messages:'登入後繼續你的對話。',tasks:'登入後查看你的任務、進度和成果。',projects:'登入後查看你的專案和相關工作。',plans:'登入後建立和管理你的自動化。',team:'登入後與你的 AI 員工一起工作。',spaces:'登入後查看和搭建你的業務工作區。',resources:'登入後新增和使用你的參考資料。',capabilities:'技能與工具幫助 Teloa 完成工作。登入後管理你的能力。',market:'發現適合你的方案與資源，登入後瀏覽和新增。',settings:'登入後在工作台中設定模型與連線。'},
} as const

/** 未登录说明使用中英文回退；公共导航仍使用工作台已有的完整语言目录。 */
export const guestCopy=(locale:ProductLocale)=>locale==='zh-CN'?zh:locale.startsWith('zh')?zhHant:en
