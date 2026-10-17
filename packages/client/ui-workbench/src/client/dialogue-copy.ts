const rows={
 session:['会话','對話','Chats'],employee:['员工','員工','Employees'],group:['群','群','Groups'],type:['对话类型','對話類型','Conversation type'],
 folders:['目录分组','目錄分組','Folders'],createFolder:['新建分组','建立分組','New folder'],renameFolder:['重命名分组','重新命名分組','Rename folder'],removeFolder:['移除分组','移除分組','Remove folder'],unfiled:['未分组','未分組','Unfiled'],empty:['还没有对话','還沒有對話','No conversations'],
 searchExpanded:['清除搜索后可折叠分组','清除搜尋後可收合分組','Clear search to collapse folders'],
 dropHere:['拖入会话或群','拖入對話或群','Drop a chat or group here'],emptyFilter:['暂无匹配对话','暫無符合的對話','No matching chats'],
 expandFolder:['展开分组','展開分組','Expand folder'],collapseFolder:['折叠分组','收合分組','Collapse folder'],
 move:['移到分组','移至分組','Move to folder'],name:['名称','名稱','Name'],save:['保存','儲存','Save'],renameAssistant:['给助手命名','為助理命名','Name your assistant'],nameHint:['留空恢复默认名称 Teloa。','留空可還原預設名稱 Teloa。','Leave blank to restore Teloa.'],
 unavailable:['姓名与目录分组暂时无法读取，请重试。','姓名與目錄分組暫時無法讀取，請重試。','Name and folder preferences could not be read. Please retry.'],
 removeHint:['只移除分组，对话会回到未分组。','只移除分組，對話會返回未分組。','Removes the folder and returns conversations to Unfiled.'],
 restore:['恢复会话','還原對話','Restore conversation'],archiveHint:['历史会保留，可从已归档目录恢复。','歷史會保留，可從已封存目錄還原。','History is kept. Restore conversations from the archived directory.'],restored:['会话已恢复。','對話已還原。','Conversation restored.'],
 invalidName:['名称需为 1～40 个字符。','名稱須為 1～40 個字元。','Use a name with 1–40 characters.'],duplicate:['已有同名目录分组。','已有同名目錄分組。','A folder with this name already exists.'],changed:['分组已变化，请重新选择。','分組已變更，請重新選擇。','The folder changed. Please select it again.'],writeFailed:['无法保存姓名或分组，请重试。','無法儲存姓名或分組，請重試。','Could not save the name or folder. Please retry.'],
} as const
export function dialogueCopy(locale:string,key:keyof typeof rows){return rows[key][locale==='zh-Hant'?1:locale.startsWith('zh')?0:2]}
export function dialogueErrorCopy(locale:string,cause:unknown){
 const message=cause instanceof Error?cause.message:''
 return dialogueCopy(locale,message==='名称需为 1～40 个字符。'?'invalidName':message==='已有同名目录分组。'?'duplicate':message==='目录分组已变化或存在同名分组。'||message==='原对话或目录分组已变化。'?'changed':'writeFailed')
}
