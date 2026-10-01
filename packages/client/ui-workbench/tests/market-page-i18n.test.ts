import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {MARKET_PAGE_MESSAGE_ROWS} from '../src/client/i18n/locales/market-page.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const url=new URL('../src/client/MarketPage.tsx',import.meta.url)
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('市场页面的固定用户界面文案全部来自词典',async()=>{
  const source=await readFile(url,'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,'MarketPage.tsx'),[])
  assert.doesNotMatch(source,/market\.page\.\d+/,'不得以编号词条代替界面语义')
})

test('市场页面词典按十语顺序完整提供代表性人工翻译',()=>{
  for(const row of MARKET_PAGE_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
  }
  assert.deepEqual(MARKET_PAGE_MESSAGE_ROWS.find(row=>row[0]==='market.industry.loadWorkspace'),[
    'market.industry.loadWorkspace','添加到我的团队','新增到我的團隊','Add to my team','自分のチームに追加','내 팀에 추가','Thêm vào đội của tôi','Añadir a mi equipo','Ajouter à mon équipe','Zu meinem Team hinzufügen','Adicionar à minha equipa',
  ])
  assert.deepEqual(MARKET_PAGE_MESSAGE_ROWS.find(row=>row[0]==='market.search.placeholder'),[
    'market.search.placeholder',"你想让员工会做什么？","你想讓員工會做什麼？","What do you want your employees to be able to do?","従業員に何をできるようにしたいですか？","직원이 무엇을 할 수 있게 하고 싶나요?","Bạn muốn nhân viên làm được việc gì?","¿Qué quieres que sepan hacer tus empleados?","Que voulez-vous que vos employés sachent faire ?","Was sollen Ihre Mitarbeitende können?","O que quer que os seus funcionários saibam fazer?",
  ])
  assert.ok(MARKET_PAGE_MESSAGE_ROWS.every(row=>!/^market\.page\.\d+$/.test(row[0])))
})
