import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {industryResourceLabels} from '../src/client/industry-manifest.ts'
import {describeIndustryResourceDestinations} from '../src/client/industry-template-presentation.ts'
import {MARKET_CATEGORIES} from '../src/client/market-home-presentation.ts'
import {MARKET_INDUSTRY_MESSAGE_ROWS} from '../src/client/i18n/locales/market-industry.ts'

const visibleKnowledgeSurfaces=[
  'BusinessPage.tsx',
  'Capabilities.tsx',
  'IndustryContents.tsx',
  'IndustryLoadForm.tsx',
  'KnowledgeSaveReceiptCard.tsx',
  'MarketForms.tsx',
  'MarketPage.tsx',
  'ResourceHistory.tsx',
  'RoleKnowledge.tsx',
  'RoleToolGrants.tsx',
  'SavedIndustryDirectory.tsx',
  'TeamCapabilitiesPage.tsx',
  'TeamPage.tsx',
  'business-preview.ts',
  'knowledge-receipt-presentation.ts',
  'market-preview.ts',
  'resource-source.ts',
  'task-detail-presentation.ts',
] as const

test('用户界面统一使用资料与知识，不再把同一模块叫工作资料或资料与能力',async()=>{
  for(const file of visibleKnowledgeSurfaces){
    const source=await readFile(new URL('../src/client/'+file,import.meta.url),'utf8')
    assert.doesNotMatch(source,/工作资料|知识资料|资料与能力|团队资料库/,file)
  }
})

test('市场原子知识与行业模板加载结果指向同一个资料',()=>{
  // 市场一级分类的中文名统一由词条给出（呈现层不再留一份中文字面量），它与加载落点说的是同一个「资料」。
  assert.ok(MARKET_CATEGORIES.includes('knowledge'))
  assert.equal(MARKET_INDUSTRY_MESSAGE_ROWS.find(row=>row[0]==='market.presentation.category.knowledge')![1],'资料')
  assert.equal(industryResourceLabels.knowledge,'知识')
  assert.deepEqual(describeIndustryResourceDestinations([
    {id:'guide',kind:'knowledge',title:'调查手册',version:'1.0.0',required:true,source:{kind:'local',path:'knowledge/guide.md'}},
  ]),[{destination:'资料',count:1}])
})
