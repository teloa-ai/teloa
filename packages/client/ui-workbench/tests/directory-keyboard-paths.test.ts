import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {mount,nodes} from './market-component-harness.ts'
import {sandboxMarket} from '../src/client/market-preview.ts'
import {marketResourceIndex} from '../src/client/market-resource-index.ts'
import {closeDirectoryDetailOnEscape} from '../src/client/directory-focus.ts'

const clientRoot=new URL('../src/client/',import.meta.url)
const read=(name:string)=>readFile(new URL(name,clientRoot),'utf8')

test('任务与持续工作详情支持 Escape 返回目录并交还原行焦点',async()=>{
  const [task,continuous]=await Promise.all([read('TaskDetail.tsx'),read('ContinuousPage.tsx')])
  assert.match(task,/data-teloa-pane="detail"[^>]+onKeyDown=\{event=>closeDirectoryDetailOnEscape\(event,back\)\}/)
  assert.match(continuous,/data-teloa-pane="detail"[^\n]+onKeyDown=\{event=>closeDirectoryDetailOnEscape\(event,\(\)=>navigate\(\{kind:isRuns\?'runs':'plans'\}\)\)\}/)
})

test('市场资源目录使用唯一 aria-selected 与方向键漫游并支持 Escape 回焦',()=>{
  const oldFrame=globalThis.requestAnimationFrame,oldElement=globalThis.Element
  globalThis.requestAnimationFrame=callback=>{callback(0);return 0}
  globalThis.Element=class {} as typeof Element
  try{
    const items=sandboxMarket().items,component=mount('MarketResourceCatalog.tsx',{'./directory-focus.js':{closeDirectoryDetailOnEscape}})
    const props:any={items,kind:'skill',selectedId:undefined,detailOpen:false,open:()=>{throw Error('方向键不得打开详情')},onSelectedChange:(id:string|undefined,detail:boolean)=>{props.selectedId=id;props.detailOpen=detail}}
    let tree=component.render('MarketResourceCatalog',props)
    const options=()=>nodes(tree).filter(node=>node.props.role==='option')
    assert.ok(options().length>=2)
    assert.equal(options().filter(node=>node.props.tabIndex===0).length,1)
    for(const key of ['ArrowDown','End','ArrowUp','Home']){
      let prevented=false
      nodes(tree).find(node=>node.props.role==='listbox')!.props.onKeyDown({key,preventDefault:()=>{prevented=true}})
      tree=component.render('MarketResourceCatalog',props)
      assert.ok(prevented)
      assert.equal(options().filter(node=>node.props['aria-selected']).length,1)
      assert.equal(options().filter(node=>node.props.tabIndex===0).length,1)
      assert.equal(nodes(tree).some(node=>node.props['data-teloa-pane']==='detail'),false)
    }
    assert.equal(options()[0]!.props['aria-selected'],true)
    // 过滤掉原选中项时，剩余首行仍可通过 Tab 进入。
    const first=options()[0]!.props['data-teloa-entry'],other=marketResourceIndex(items).find(row=>row.kind==='skill'&&row.key!==first)!
    tree=component.render('MarketResourceCatalog',{...props,query:other.id})
    assert.equal(options().filter(node=>node.props.tabIndex===0).length,1)
    const bundle=items.find(item=>item.id==='bundle-security')!,reference=marketResourceIndex([bundle]).find(row=>row.kind==='skill')!
    const referenceProps:any={items:[bundle],kind:'skill',selectedId:undefined,detailOpen:false,open:()=>{throw Error('纯引用不得直接打开实体详情')},onSelectedChange:(id:string|undefined,detail:boolean)=>{referenceProps.selectedId=id;referenceProps.detailOpen=detail}}
    tree=component.render('MarketResourceCatalog',referenceProps)
    nodes(tree).find(node=>node.props['data-teloa-entry']===reference.key)!.props.onClick()
    tree=component.render('MarketResourceCatalog',referenceProps)
    const detail=nodes(tree).find(node=>node.props['data-teloa-pane']==='detail')!
    let prevented=false,stopped=false
    detail.props.onKeyDown({key:'Escape',defaultPrevented:false,target:null,preventDefault:()=>{prevented=true},stopPropagation:()=>{stopped=true}})
    tree=component.render('MarketResourceCatalog',referenceProps)
    assert.ok(prevented&&stopped)
    assert.equal(tree.props['data-resource-layer'],'list')
    assert.equal(options().filter(node=>node.props.tabIndex===0).length,1)
  }finally{globalThis.requestAnimationFrame=oldFrame;globalThis.Element=oldElement}
})

test('任务、持续工作和市场资源目录在窄屏提供至少 44px 主要目标',async()=>{
  const [taskStyles,marketStyles]=await Promise.all([read('TaskPage.module.css'),read('MarketPage.module.css')])
  assert.match(taskStyles,/@media\(max-width:760px\)\{[\s\S]*\.page button,[^}]*\.page select\{[^}]*min-height:44px/)
  assert.match(taskStyles,/@media\(max-width:760px\)\{[^}]*\.page \.tableLink\{[^}]*min-height:44px/)
  assert.match(taskStyles,/@media\(max-width:760px\)\{[\s\S]*\.search\{[^}]*min-height:44px/)
  const catalog=mount('MarketResourceCatalog.tsx').render('MarketResourceCatalog',{items:sandboxMarket().items,kind:'skill',open:()=>{}})
  const entry=nodes(catalog).find(node=>node.props.role==='option')!
  assert.equal(entry.type,'button')
  assert.equal(entry.props.className,'itemCard')
  assert.match(marketStyles,/@media\(max-width:740px\)\{[\s\S]*\.page button\{[^}]*min-height:44px[^}]*min-width:44px/)
  assert.match(marketStyles,/\.itemCard\[aria-selected=true\]/)
})
