import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {MARKET_INDUSTRY_MESSAGE_ROWS} from '../src/client/i18n/locales/market-industry.ts'
import {MARKET_SKILL_CONTROL_MESSAGE_ROWS} from '../src/client/i18n/locales/market-skill-controls.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const files=[
  'IndustryContents.tsx','IndustryDiscoveryList.tsx','IndustryExport.tsx',
  'IndustryLoadForm.tsx','IndustryPlanSourcePanel.tsx','IndustryReferences.tsx','IndustryResourceBrowser.tsx',
  'IndustryTaskForm.tsx','IndustryTaskSourcePanel.tsx','IndustryUpdateForm.tsx','MarketResourceCatalog.tsx',
  'SavedIndustryTaskForm.tsx','SavedIndustryPlanForm.tsx',
  'SkillAvailabilityPanel.tsx','SkillInstallControl.tsx','SkillInstallationStatus.tsx','AtomicSkillImport.tsx',
] as const
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('市场与行业模板固定界面文案全部来自词典',async()=>{
  for(const file of files){
    const source=await readFile(new URL('../src/client/'+file,import.meta.url),'utf8')
    assert.match(source,/useI18n\(/,file)
    assert.deepEqual(chineseUiLiterals(source,file),[],file)
    assert.doesNotMatch(source,/toLocale(?:Date|Time|String)\(['"]zh-CN['"]/,file)
    assert.doesNotMatch(source,/instanceof Error\s*\?\s*\w+\.message/,file)
    assert.doesNotMatch(source,/\{api\.recoveryMessage\(\)\}|\|\|api\.recoveryMessage\(\)/,file)
  }
})

test('市场与行业模板词典按十语顺序完整提供',()=>{
  const rows=[...MARKET_INDUSTRY_MESSAGE_ROWS,...MARKET_SKILL_CONTROL_MESSAGE_ROWS]
  assert.ok(rows.length>=60)
  for(const row of rows){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
    const placeholders=[...(row[3]?.match(/\{[^}]+\}/g)??[])].sort()
    for(const [index,locale] of locales.slice(3).entries())assert.deepEqual([...(row[index+4]?.match(/\{[^}]+\}/g)??[])].sort(),placeholders,`${row[0]}: ${locale} placeholders`)
  }
  assert.deepEqual(rows.find(row=>row[0]==='market.industry.browser.search'),[
    'market.industry.browser.search','搜索资源','搜尋資源','Search resources','リソースを検索','리소스 검색','Tìm kiếm tài nguyên','Buscar recursos','Rechercher des ressources','Ressourcen suchen','Pesquisar recursos',
  ])
  assert.deepEqual(rows.find(row=>row[0]==='market.catalog.clear'),[
    'market.catalog.clear','清除筛选','清除篩選','Clear filters','絞り込みを解除','필터 지우기','Xóa bộ lọc','Borrar filtros','Effacer les filtres','Filter löschen','Limpar filtros',
  ])
  assert.deepEqual(rows.find(row=>row[0]==='market.skill.status.continue'),[
    'market.skill.status.continue','继续核对安装','繼續核對安裝','Continue review','確認を続ける','검토 계속','Tiếp tục xem xét','Continuar revisión','Continuer la vérification','Prüfung fortsetzen','Continuar revisão',
  ])
})

test('市场固定文案简繁英定稿，其余语言保留既有译文或英文回退',()=>{
  const rows=[...MARKET_INDUSTRY_MESSAGE_ROWS,...MARKET_SKILL_CONTROL_MESSAGE_ROWS]
  for(const row of rows){
    for(const [index,locale] of locales.slice(0,3).entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
    // 延期语言保留已有内容；旧英文回退不必随本轮英文重新措辞，也不冒称已完成翻译。
    for(const [offset,value] of row.slice(4).entries()){
      assert.ok(value.trim(),`${row[0]}: ${locales[offset+3]}`)
      assert.doesNotMatch(value,/\n_|障害者|장애인|Discapacitado/,`${row[0]} contains a damaged or misleading translation`)
    }
  }
  assert.deepEqual(rows.find(row=>row[0]==='market.presentation.status.disabled')?.slice(1,4),['已停用','已停用','Disabled'])
})

test('三类业务定制声明的类型名进十一列词表且零回落',()=>{
 const rows=MARKET_INDUSTRY_MESSAGE_ROWS.filter(row=>['market.industry.resource.object-type','market.industry.resource.business-view','market.industry.resource.business-action'].includes(row[0]))
 assert.equal(rows.length,3)
 for(const row of rows){assert.equal(row.length,11);assert.equal(new Set(row.slice(1)).size>=8,true,row[0]+' 不得多语共用同一串')}
})
