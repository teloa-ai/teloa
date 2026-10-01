import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes} from './market-component-harness.ts'
import * as produced from '../src/client/produced-files.ts'

const subject=()=>mount('ProducedFileCards.tsx',{'./produced-files.js':produced})
const owner=(produced:unknown)=>({turn:{data:{get:(key:string)=>key==='deliverables'?{produced}:undefined}},seq:7})

test('原生轮尾贡献没有本轮产出时不显示文件卡片',()=>{
  const component=subject()
  assert.equal(component.render('ProducedFileCards',{...owner([]),preview:()=>{},openFile:()=>{}}),null)
})

test('多会话轮尾仅显示自己的产出，保留官方文件打开动作',()=>{
  const component=subject(),opened:string[]=[],previewed:string[]=[]
  const rendered=component.render('ProducedFileCards',{
    ...owner([{seq:4,path:'child/report.pdf'},{seq:9,path:'later.xlsx'}]),
    preview:(path:string)=>previewed.push(path),openFile:(path:string)=>opened.push(path),
  })
  const buttons=nodes(rendered).filter(node=>node.type==='button')
  assert.equal(buttons.length,2)
  buttons[0]!.props.onClick()
  buttons[1]!.props.onClick()
  assert.deepEqual(previewed,['child/report.pdf'])
  return Promise.resolve().then(()=>assert.deepEqual(opened,['child/report.pdf']))
})
