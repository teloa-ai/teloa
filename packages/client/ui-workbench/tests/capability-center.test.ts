import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {groupCapabilityConnectors} from '../src/client/capability-center-catalog.ts'
import {mount,nodes,marketProps} from './market-component-harness.ts'

test('市场旧路由和能力目录共用一个侧栏入口，保留资料库',()=>{
 for(const view of ['market','capabilities']){
  const page=mount('WorkbenchNavigationChrome.tsx')
  const tree=page.render('WorkbenchNavigationItems',{view,onSelect:()=>{}})
  const buttons=nodes(tree).filter(node=>node.type==='button')
  const contains=(node:any,key:string)=>nodes(node).some(n=>n.children.includes(key))
  assert.equal(buttons.filter(node=>contains(node,'capabilityCenter.title')).length,1)
  assert.equal(buttons.some(node=>contains(node,'navigation.v2.market')),false)
  assert.equal(buttons.find(node=>contains(node,'capabilityCenter.title'))?.props['aria-current'],'page')
  assert.ok(buttons.some(node=>contains(node,'navigation.v2.library')))
 }
})

test('同服务器多项 MCP 工具合并，含下划线服务器名也保留独立身份',()=>{
 const tool=(name:string)=>({key:'source:'+name,rowId:'source',title:name,state:'discovered',origin:{kind:'studio'},go:{kind:'connectors'}} as any)
 const original=[tool('mcp__github__search'),tool('mcp__github__get_issue'),tool('mcp__my_notes__read'),tool('mcp__my_notes__write')]
 const rows=groupCapabilityConnectors(original)
 assert.equal(rows.length,2)
 assert.equal(rows[0]!.title,'GitHub')
 assert.equal(rows[0]!.state,'discovered','发现工具不变为已连接')
 assert.equal(rows[1]!.key,'connector:my_notes')
 assert.equal(rows[1]!.toolKeys?.length,2)
 assert.equal(original[0].key,'source:mcp__github__search','不改共享能力来源')
})

test('图标识别产品自身，不把 Codex 市场来源当作每个技能的 Logo',()=>{
 const page=mount('ResourceIcon.tsx',{'./resource-icon-assets.js':{resourceBrands:{github:'github.svg',codex:'codex.svg'},resourceAvatars:{general:'general.webp'}}})
 assert.equal(page.exported.resourceBrand('codex.research','资料研究'),undefined)
 assert.equal(page.exported.resourceBrand('teloa.github','GitHub'),'github')
 assert.equal(page.exported.resourceBrand('source:mcp__github__search','GitHub'),'github')
})

test('实际工作台把市场、资料库和能力搜索写回导航目录',()=>{
 const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 for(const directory of ['market','resources','capabilities']){
  const source=frame.match(new RegExp("onNavigationChange=\\{next=>(actions\\.rememberDirectory\\('"+directory+"',\\{[^}]+category:[^}]+\\}\\),selectedId:next\\.selectedId\\}\\))\\}"))?.[1]
  assert.ok(source,directory+' 目录回写入口')
  let written:any
  new Function('actions','writeDirectoryFilterCategory','next',source)({rememberDirectory:(name:string,state:any)=>written={name,state}},(value:any)=>JSON.stringify(value),{query:'测试搜索',category:'skill',mobileLayer:'list',selectedId:undefined})
  assert.equal(written.state.query,'测试搜索',directory+' 应保留搜索')
 }
})

test('统一发现首页显示全部类型，技能和连接器筛选仍限定类型',()=>{
 const section=()=>null
 for(const [category,kind] of [['home',undefined],['skill','skill'],['connector','connector']] as const){
  const page=mount('MarketPage.tsx',{'./MarketCatalogSection.js':{MarketCatalogSection:section}})
  const tree=page.render('TestCatalog',{...marketProps({category}),inCapabilityCenter:true,marketCatalogApi:{},runtime:{state:'ready',facts:[]}})
  const catalog=nodes(tree).find(node=>node.type===section)!
  assert.ok(catalog)
  assert.deepEqual(catalog.props.kinds,kind?[kind]:undefined)
  assert.equal(catalog.props.cardLayout,true)
  assert.equal(nodes(tree).some(node=>node.type==='h1'),false,'共用能力中心标题，不再重复市场标题')
 }
})

test('我的与发现切换有明确选中状态且只执行所选导航',()=>{
 const calls:string[]=[]
 const page=mount('CapabilityCenterHeader.tsx')
 for(const mode of ['mine','discover']){
  const tree=page.render('CapabilityCenterHeader',{mode,onMine:()=>calls.push('mine'),onDiscover:()=>calls.push('discover'),onInstallations:()=>calls.push('installations'),onSettings:()=>calls.push('settings')})
  const buttons=nodes(tree).filter(node=>node.type==='button')
  const contains=(node:any,key:string)=>nodes(node).some(n=>n.children.includes(key))
  assert.equal(buttons.find(node=>node.children.includes('capabilityCenter.'+mode))?.props['aria-pressed'],true)
  buttons.find(node=>node.children.includes('capabilityCenter.'+(mode==='mine'?'discover':'mine')))?.props.onClick()
 }
 assert.deepEqual(calls,['discover','mine'])
})
