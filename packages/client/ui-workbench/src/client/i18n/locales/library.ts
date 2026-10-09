const rows=[
 ['views','浏览资料','瀏覽資料','Browse materials'],
 ['noRecent','还没有访问记录','尚未有瀏覽記錄','No recent materials'],
 ['browseAll','查看全部资料','查看全部資料','View all materials'],
 ['title','资料库','資料庫','Library'],
 ['add','添加资料','新增資料','Add materials'],
 ['available','可引用','可引用','Available'],
 ['description','整理资料、保留来源，随时用于下一项工作。','整理資料、保留來源，隨時用於下一項工作。','Organize source material and use it in your next task.'],
 ['mine','全部资料','全部資料','All materials'],['recent','最近访问','最近開啟','Recent'],['star','我的收藏','我的收藏','Favorites'],['local','本地文件','本機檔案','Local files'],['space','空间','空間','Spaces'],
 ['search','搜索资料名称或所在位置','搜尋資料名稱或所在位置','Search materials or locations'],['clear','清空搜索','清除搜尋','Clear search'],['back','返回列表','返回清單','Back to list'],['use','用于任务','用於任務','Use in task'],
 ['name','名称','名稱','Name'],['location','位置','位置','Location'],['status','状态','狀態','Status'],['visited','最近访问','最近開啟','Last opened'],['unvisited','尚未访问','尚未開啟','Not opened'],
 ['favorite','收藏 {name}','收藏 {name}','Favorite {name}'],['unfavorite','取消收藏 {name}','取消收藏 {name}','Unfavorite {name}'],
 ['noMatch','没有找到匹配的资料','找不到符合條件的資料','No matching materials'],['empty','还没有资料','尚未有資料','No materials yet'],['emptyRecent','打开资料后，会显示在这里。','開啟資料後，會顯示在這裡。','Materials appear here after you open them.'],['emptyStar','收藏常用资料，方便下次找到。','收藏常用資料，方便下次找到。','Favorite materials to find them easily next time.'],['emptyLocal','登记本地文件后，会显示在这里。','登記本機檔案後，會顯示在這裡。','Registered local files appear here.'],
 ['count','{count} 项资料','{count} 項資料','{count} materials'],['prepare','请根据这份资料帮助我完成工作：{name}','請根據這份資料協助我完成工作：{name}','Help me complete a task using this material: {name}'],['storage','无法保存最近访问或收藏，本次选择仍可使用。','無法儲存最近開啟或收藏，本次選擇仍可使用。','Recent items or favorites could not be saved. Your current selection is still available.'],
 ['unsaved','资料有未保存的修改。离开会丢弃这些修改。','資料有未儲存的修改。離開會放棄這些修改。','This material has unsaved changes. Leaving will discard them.'],['stay','继续编辑','繼續編輯','Keep editing'],['leave','放弃修改并离开','放棄修改並離開','Discard changes and leave'],
] as const
export type LibraryMessageKey=`library.${typeof rows[number][0]}`
export const LIBRARY_MESSAGE_KEYS=rows.map(row=>`library.${row[0]}` as LibraryMessageKey)
const column=(i:1|2|3)=>Object.fromEntries(rows.map(row=>[`library.${row[0]}`,row[i]])) as Readonly<Record<LibraryMessageKey,string>>
export const libraryMessages={'zh-CN':column(1),'zh-Hant':column(2),en:column(3)}
export const libraryHongKongMessages={...column(2),'library.local':'本機檔案','library.search':'搜尋資料名稱或所在位置'}
