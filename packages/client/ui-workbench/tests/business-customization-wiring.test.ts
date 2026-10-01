import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const [frame,page,ledger,panel,api,entry]=await Promise.all([
 readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/BusinessLedger.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/BusinessCustomization.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/business-customization-api.ts',import.meta.url),'utf8'),
 readFile(new URL('../src/client/index.ts',import.meta.url),'utf8'),
])

test('装配处把会话定制 API 传进真实台账概览，并在刷新后重读台账',()=>{
 assert.match(frame,/businessCustomizationApi=\{businessCustomizationApi\}/)
 assert.match(page,/target\.section==='overview'[\s\S]*<BusinessCustomization/)
 assert.match(page,/ledgerVisible&&<BusinessLedgerSurface refreshKey=\{ledgerRevision\}/)
 assert.match(page,/previewReceipt:preview\.receipt/)
})

test('确认只使用预览回包的回执与纯函数给出的乐观判据；冲突会强制重读预览',()=>{
 assert.match(panel,/const guard=customizationApplyGuard\(preview,authoritativeEntry\(directory,preview\)\)/)
 assert.match(panel,/previewReceipt:preview\.receipt,\.\.\.guard/)
 assert.match(panel,/previewReceipt:preview\.receipt/)
 assert.match(panel,/key==='business\.custom\.conflict'\)void loadPreview\(preview\.draft\.id\)/)
 assert.match(api,/\['schema','draft','receipt','base','diff','diffTruncated','impact','computedAt'/)
})

test('声明更新缓存按范围留在模块级；本地标记取服务端 origin，不从形状推断',()=>{
 assert.match(ledger,/const ledgerKeys=new Map<string,Map<string,string>>\(\)/)
 assert.match(ledger,/const previous=ledgerKeys\.get\(scope\)/)
 assert.match(ledger,/localCustomized=\{blockLocalCustomized\(row\)\}/)
 assert.match(ledger,/data-local-customized/)
})

test('会话定制 API 的装配把宿主错误的 details 一并带给界面（crossReference 据此区分两种 invalid-input）',()=>{
 assert.match(entry,/createBusinessCustomizationApi\(async\(endpoint,payload,signal\)=>\{[^\n]*code:result\.error\.code,details:result\.error\.details\}/)
})
