import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const read=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

test('业务内页「更多」菜单接 useDismissible，点菜单项后自己收起',async()=>{
 const [source,page]=await Promise.all([read('BusinessMoreMenu.tsx'),read('BusinessPage.tsx')])
 assert.match(source,/useDismissible\(ref,open,\(\)=>setOpen\(false\)\)/)
 assert.match(source,/<details ref=\{ref\} className=\{css\.scopeMore\}[^>]*open=\{open\} onToggle=\{event=>setOpen\(event\.currentTarget\.open\)\}>/)
 assert.match(source,/const pick=\(action:BusinessMoreAction\)=>\{setOpen\(false\);choose\(action,scope\)\}/)
 assert.match(page,/<BusinessMoreMenu scope=\{target\.scope\} choose=\{chooseMore\}\/>/)
 const actions=['work','completed','dashboards','automations','adjustment','connector','sources','manual-definition','share']
 for(const action of actions)assert.match(source,new RegExp(`onClick=\\{\\(\\)=>pick\\('${action}'\\)\\}`),action+' 应经 pick 收起菜单并保留范围')
})

test('市场「导入」「自己做一个」两个下拉都接 useDismissible',async()=>{
 const source=await read('MarketPage.tsx')
 assert.match(source,/useDismissible\(importMenuRef,importMenuOpen,\(\)=>setImportMenuOpen\(false\)\)/)
 assert.match(source,/useDismissible\(createMenuRef,createMenuOpen,\(\)=>setCreateMenuOpen\(false\)\)/)
 assert.match(source,/<details ref=\{importMenuRef\} className=\{css\.toolMenu\} open=\{importMenuOpen\}/)
 assert.match(source,/<details ref=\{createMenuRef\} className=\{css\.toolMenu\} open=\{createMenuOpen\}/)
})

test('CreateEntry「用一句话描述」展开区接 useDismissible，并带内容守卫',async()=>{
 const source=await read('CreateEntry.tsx')
 assert.match(source,/useDismissible\(sentenceGroup,sentenceOpen,\(\)=>setSentenceOpen\(false\),source=>source==='escape'\|\|!sentence\.trim\(\)\)/)
 assert.match(source,/<div ref=\{sentenceGroup\} className=\{css\.sentenceGroup\}>/)
})

test('共享 hook 只有一份：新建菜单、业务更多组件、BusinessHome、市场下拉与 CreateEntry 复用同一模块',async()=>{
 const files=['WorkNavigation.tsx','BusinessMoreMenu.tsx','BusinessHome.tsx','MarketPage.tsx','CreateEntry.tsx']
 for(const file of files){
  const source=await read(file)
  assert.match(source,/from '\.\/use-dismissible\.js'/,file+' 应该复用 use-dismissible.ts')
 }
})
