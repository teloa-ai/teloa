const rows=[
 ['track','跟踪本机文件','追蹤本機檔案','Track a local file'],
 ['path','工作文件夹内的相对路径','工作資料夾內的相對路徑','Path relative to the working folder'],
 ['boundary','登记本人工作文件夹中的 Markdown 原件。核对草稿并加入资料后才可引用；登记不会执行任务或扩大员工、分身的授权。','登記本人工作資料夾中的 Markdown 原件。核對草稿並加入資料後才可引用；登記不會執行任務或擴大員工、分身的授權。','Register an original Markdown file in your working folder. Review and apply its draft before use. Registration does not run tasks or extend role permissions.'],
 ['save','登记并准备草稿','登記並準備草稿','Register and prepare draft'],
 ['ready','本机文件草稿已准备好，请核对后加入资料。','本機檔案草稿已準備好，請核對後加入資料。','Local file draft ready. Review it before adding it to the library.'],
 ['unknown','登记或草稿回包尚需核对；将沿用原文件、原版本和原请求。','登記或草稿回包仍待核對；將沿用原檔案、原版本及原請求。','Check the uncertain registration or draft result using the original file, version, and requests.'],
 ['recover','核对原文件登记','核對原檔案登記','Check original registration'],
 ['preview','本机文件 · 只读预览','本機檔案 · 唯讀預覽','Local file · read-only preview'],
 ['previewBoundary','正文来自本人已登记的本机原件，只读取所选来源版本。请在工作文件夹中编辑原文件。','正文來自本人已登記的本機原件，只讀取所選來源版本。請在工作資料夾中編輯原檔案。','This preview reads the selected version of your registered local file. Edit the original file in your working folder.'],
 ['changed','文件或资料版本已变化，请刷新资料目录后重新选择。此处不会替换原版本正文。','檔案或資料版本已變更，請重新整理資料目錄後再次選擇。此處不會取代原版本正文。','The file or library record has changed. Refresh the library and select it again. This preview does not replace the original version.'],
 ['unavailable','当前宿主暂不能预览此本机文件，请检查连接后重试。','目前主機暫時無法預覽此本機檔案，請檢查連線後再試。','The current host cannot preview this local file. Check the connection and try again.'],
 ['retry','重新读取原版本','重新讀取原版本','Retry selected version'],
 ['withdrawn','此资料已撤回，保留来源记录；正文不再读取。','此資料已撤回，保留來源記錄；不再讀取正文。','This library item has been withdrawn. Its source record is retained; its content is no longer read.'],
 ['fileVersion','文件版本','檔案版本','File version'],
 ['versionBoundary','原文件的编辑记录不在此处保存；既有引用仍锁定原版本。','原檔案的編輯記錄不會在此處儲存；既有引用仍鎖定原版本。','Original file edit history is not stored here. Existing references keep their locked version.'],
] as const
export type LocalMaterialMessageKey=`knowledge.local.${typeof rows[number][0]}`
export const LOCAL_MATERIAL_MESSAGE_KEYS=rows.map(row=>`knowledge.local.${row[0]}` as LocalMaterialMessageKey)
const column=(i:1|2|3)=>Object.fromEntries(rows.map(row=>[`knowledge.local.${row[0]}`,row[i]])) as Readonly<Record<LocalMaterialMessageKey,string>>
export const localMaterialMessages={'zh-CN':column(1),'zh-Hant':column(2),en:column(3)}
