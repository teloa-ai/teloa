import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'

const root=new URL('../src/client/',import.meta.url)

test('WorkspaceSearch 固定文案来自词典、安全映射错误，并按最新定稿分类展示平面结果',async()=>{
  const source=await readFile(new URL('WorkspaceSearch.tsx',root),'utf8')
  assert.match(source,/useI18n\(\)/)
  assert.match(source,/localizeWorkError\(locale,caught\)/)
  assert.match(source,/searchWorkspace\(source,query\)/)
  assert.match(source,/visibleResults\.map\(row=>/)
  assert.match(source,/<ArrowUpRight size=\{14\} aria-hidden="true"\/>/)
  assert.match(source,/t\('workspaceSearch\.emptyTitle'\)/)
  assert.match(source,/t\('workspaceSearch\.emptyDescription'\)/)
  assert.match(source,/t\('workspaceSearch\.searchMessagesTitle',\{query:trimmedQuery\}\)/)
  // 1.0 页签带计数：列表与计数共用同一份未筛选结果，再按当前分类收窄。
  assert.match(source,/const allResults=searchWorkspace\(source,query\)/)
  assert.match(source,/filterWorkspaceSearchResults\(allResults,selectedKind\)/)
  assert.match(source,/const kindCount=\(kind:WorkspaceSearchKindFilter\)=>filterWorkspaceSearchResults\(allResults,kind\)\.length/)
  assert.match(source,/\{kindCount\(kind\)>0&&<span className=\{css\.count\} aria-hidden="true">\{kindCount\(kind\)\}<\/span>\}/)
  assert.match(source,/t\('workspaceSearch\.select'\)/)
  assert.match(source,/t\('workspaceSearch\.open'\)/)
  assert.match(source,/role="tablist"/)
  assert.match(source,/role="option"[^]*?aria-selected=\{activeKey===row\.key\}/)
  assert.match(source,/dialogueCopy\(locale,kind==='group'\?'group':'session'\)/)
  assert.doesNotMatch(source,/t\('workspaceSearch\.kindAria'\)/)
  assert.doesNotMatch(source,/t\('workspaceSearch\.note'\)/)
  assert.match(source,/t\('workspaceSearch\.close'\)/)
  assert.doesNotMatch(source,/caught instanceof Error\s*\?\s*caught\.message/)
  assert.deepEqual(chineseUiLiterals(source,'page.tsx'),[])
})

test('WorkspaceSearch 十种主语言都有完整词条',async()=>{
  const source=await readFile(new URL('i18n/locales/workspace-search.ts',root),'utf8')
  const rows=[...source.matchAll(/\br\(['"]workspaceSearch\.[^'"]+['"]\s*,/g)]
  assert.ok(rows.length>=20)
  assert.match(source,/WORKSPACE_SEARCH_MESSAGE_ROWS/)
  for(const key of ['workspaceSearch.detail.knowledge','workspaceSearch.detail.market','workspaceSearch.knowledgeLoading','workspaceSearch.knowledgeUnavailable'])assert.match(source,new RegExp(key.replaceAll('.','\\.')))
  for(const key of ['workspaceSearch.detail.skill','workspaceSearch.detail.plugin','workspaceSearch.detail.mcp','workspaceSearch.capabilityLoading','workspaceSearch.capabilityUnavailable'])assert.match(source,new RegExp(key.replaceAll('.','\\.')))
  for(const key of ['workspaceSearch.emptyTitle','workspaceSearch.emptyDescription','workspaceSearch.searchMessagesTitle','workspaceSearch.detail.messages'])assert.match(source,new RegExp(key.replaceAll('.','\\.')))
  for(const key of ['workspaceSearch.kindAria','workspaceSearch.all','workspaceSearch.note','workspaceSearch.section','workspaceSearch.duplicateId'])assert.doesNotMatch(source,new RegExp('\\br\\([\'"]'+key.replaceAll('.','\\.')+'[\'"]'))
})

test('WorkbenchFrame 只把已保存对象交给全局搜索',async()=>{
  const source=await readFile(new URL('WorkbenchFrame.tsx',root),'utf8')
  assert.match(source,/workspaceSearchSource/)
  assert.match(source,/storage==='persistent'/)
  assert.match(source,/searchableKnowledgeDocuments/)
  assert.match(source,/resourceApi\.directory\(\)/)
  assert.match(source,/resourceApi\.sources\(\)/)
  assert.match(source,/resourceApi\.knowledgeTree\(\)/)
  assert.match(source,/actions\.openResource\(row\.id\)/)
  assert.match(source,/loadWorkspaceCapabilitySearchDirectory/)
  assert.match(source,/actions\.openInstallations\(found\.open\.id\)/)
  assert.match(source,/selectedId:found\.open\.selectedId/)
  assert.match(source,/localizedMarketItemCopy\(item,locale\)/)
  assert.match(source,/searchableMarketItems\(\)\.some\(item=>item\.id===row\.id\)/)
  assert.match(source,/currentSolutionCatalog\(marketRef\.current\.items\)\.filter\(item=>marketCategoryOf\(item\)!=='work-template'\)/)
  assert.match(source,/actions\.openMarket\(row\.id\)/)
  assert.doesNotMatch(source,/source=\{\{conversations:searchableConversations,tasks:tasks\.tasks,roles:tasks\.roles,groups:collaboration\.groups,spaces:tasks\.business\.spaces\}\}/)
})

test('团队能力页在全局搜索打开目标后同步外部目录定位',async()=>{
  const source=await readFile(new URL('TeamCapabilitiesPage.tsx',root),'utf8')
  assert.match(source,/if\(!visible\)return/)
  assert.match(source,/navigationState\?\.selectedId!==undefined&&navigationState\.selectedId!==selectedKey/)
  assert.match(source,/setSelectedKey\(navigationState\.selectedId\)/)
  assert.match(source,/setMobileLayer\(navigationState\.mobileLayer\)/)
})
