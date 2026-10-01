import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const root=new URL('../src/client/',import.meta.url)
const read=(name:string)=>readFile(new URL(name,root),'utf8')

test('真实业务对象详情只通过正式创建接口创建调查任务',async()=>{
 const [page,frame,index,locale]=await Promise.all([read('BusinessPage.tsx'),read('WorkbenchFrame.tsx'),read('index.ts'),read('i18n/locales/business-page.ts')])
 assert.match(page,/BusinessTaskCreateForm/)
 assert.match(page,/businessTaskApi/)
 assert.match(page,/selectedItem\.snapshotHash/)
 assert.match(page,/actionId/)
 assert.match(page,/persistentBusinessTaskAssignees/)
 assert.match(page,/BusinessTaskRecovery/)
 assert.match(page,/ledgerVisible&&<BusinessLedgerSurface/)
 assert.doesNotMatch(page,/businessTasksForMode/)
 assert.match(frame,/createBusinessSavedTask/)
 assert.match(frame,/mergeSavedTasks\(\[result\.task\]\)/)
 assert.match(frame,/actions\.openTask\(result\.task\.id\)/)
 assert.doesNotMatch(frame,/createBusinessSavedTask=.*void loadTasks/)
 assert.match(index,/createBusinessTaskApi/)
 assert.match(index,/teloa\.business-task\/v1/)
 assert.match(locale,/business\.task\.create/)
 assert.doesNotMatch(page,/sandbox-demo/)
})
