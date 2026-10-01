import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

// 真实组件走 tsc 产物；CSS Modules 只替换类名，不模拟组件行为。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {EventTimeline}=await import('../lib/types/client/EventTimeline.js')
const {StatusBox}=await import('../lib/types/client/StatusBox.js')
const {PropertyRail}=await import('../lib/types/client/PropertyRail.js')
const {ObjectPageHeader}=await import('../lib/types/client/ObjectPageHeader.js')
const noop=()=>{}
const paint=(component:unknown,props:Record<string,unknown>)=>renderToStaticMarkup(createElement(component as never,props as never))
const source=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')
const ev=(id:string,kind:string,at:string,extra:Record<string,unknown>={})=>({id,kind,at,title:id,...extra})
const timelineProps={ariaLabel:'timeline',emptyText:'nothing yet',foldLabel:(k:string,n:number,key:string)=>k+'·'+n+'·'+key,expandLabel:'expand',collapseLabel:'collapse',stamp:(at:string)=>'@'+at}

test('EventTimeline：五条同 foldKey 事件折成一条，按钮文案来自 foldLabel 且默认收起',()=>{
 const runs=[1,2,3,4,5].map(n=>ev('r'+n,'run',`2026-09-21T0${n}:00:00Z`,{foldKey:'run'}))
 const html=paint(EventTimeline,{...timelineProps,events:runs})
 assert.equal(html.match(/data-teloa-fold="run"/g)?.length,1)
 assert.match(html,/run·5·run/)
 assert.match(html,/<button[^>]*aria-expanded="false"[^>]*>run·5·run<\/button>/)
 // 折叠组的事件常驻 DOM（内容面靠挂载才能拉数据），只是 <ol hidden>。
 assert.equal(html.match(/data-teloa-event="run"/g)?.length,5)
 assert.match(html,/<ol id="[^"]+" hidden="" class="events">/)
})
test('EventTimeline：detail 常驻挂载——收起时带 hidden，展开（pending）后无 hidden',()=>{
 const collapsed=paint(EventTimeline,{...timelineProps,events:[ev('c','trigger','2026-09-21T01:00:00Z',{detail:'first page loader'})]})
 assert.match(collapsed,/<div id="[^"]+" hidden="" class="detail">first page loader<\/div>/)
 assert.match(collapsed,/aria-expanded="false"/)
 const expanded=paint(EventTimeline,{...timelineProps,events:[ev('p','trigger','2026-09-21T01:00:00Z',{pending:true,detail:'first page loader'})]})
 assert.match(expanded,/<div id="[^"]+" class="detail">first page loader<\/div>/)
})
test('EventTimeline：pending 事件默认展开并显示 detail；空数组显示 emptyText',()=>{
 const html=paint(EventTimeline,{...timelineProps,events:[ev('p','approval','2026-09-21T01:00:00Z',{pending:true,detail:'approve now please',anchor:'approval-p'})]})
 assert.match(html,/aria-expanded="true"/)
 assert.match(html,/approve now please/)
 assert.match(html,/data-teloa-anchor="approval-p"/)
 assert.match(html,/data-teloa-event="approval"/)
 assert.match(html,/<time dateTime="2026-09-21T01:00:00Z">@2026-09-21T01:00:00Z<\/time>/)
 assert.match(paint(EventTimeline,{...timelineProps,events:[]}),/nothing yet/)
})
test('StatusBox：主按钮带 data-teloa-primary，次级按钮并列，hint 落成 title',()=>{
 const html=paint(StatusBox,{ariaLabel:'status',tone:'warn',sentence:'waiting on you',hint:'why this',hintLabel:'more',primary:{label:'Approve',onSelect:noop},secondary:{label:'Later',onSelect:noop}})
 assert.match(html,/<section[^>]*aria-label="status"[^>]*data-teloa-status-box/)
 assert.match(html,/<button[^>]*data-teloa-primary[^>]*>Approve<\/button>/)
 assert.equal(html.match(/<button/g)?.length,2)
 assert.match(html,/title="why this"/)
 assert.match(html,/aria-label="more"/)
})
test('PropertyRail：可打开行是 button，普通行是 span，mono 与 anchor 落到属性',()=>{
 const html=paint(PropertyRail,{ariaLabel:'rail',expandLabel:'expand',collapseLabel:'collapse',rows:[
  {id:'owner',label:'Owner',value:'Alice',onOpen:noop,openLabel:'open owner'},
  {id:'id',label:'ID',value:'task_1',mono:true,anchor:'x'},
  {id:'plain',label:'Created',value:'yesterday'},
 ]})
 assert.match(html,/<button[^>]*aria-label="open owner"[^>]*>Alice/)
 assert.match(html,/<span class="mono">task_1<\/span>/)
 assert.match(html,/<span>yesterday<\/span>/)
 assert.match(html,/data-teloa-anchor="x"/)
 assert.match(html,/<aside[^>]*aria-label="rail"/)
})
test('ObjectPageHeader：菜单触发按钮 aria-haspopup，静态渲染下菜单闭合；标题按钮包 h2；backHidden 不渲染返回',()=>{
 const html=paint(ObjectPageHeader,{title:'Fix login',onEditTitle:noop,editTitleLabel:'edit title',status:{label:'Running',tone:'info'},menu:[{id:'archive',label:'Archive',onSelect:noop}],menuLabel:'more actions',back:noop,backLabel:'back'})
 assert.match(html,/<button[^>]*aria-haspopup="menu"[^>]*aria-label="more actions"/)
 assert.doesNotMatch(html,/role="menu"/)
 assert.match(html,/<h2 aria-label="Fix login"><button[^>]*aria-label="edit title"[^>]*><span[^>]*title="Fix login"[^>]*>Fix login<\/span><svg/)
 assert.match(html,/class="back"/)
 assert.match(html,/data-tone="info" data-mark="inactive"/)
 const hidden=paint(ObjectPageHeader,{title:'Fix login',status:{label:'Done',tone:'good'},menuLabel:'more actions',back:noop,backLabel:'back',backHidden:true})
 assert.doesNotMatch(hidden,/class="back"/)
 assert.match(hidden,/<h2[^>]*title="Fix login"[^>]*>Fix login<\/h2>/)
 assert.doesNotMatch(hidden,/aria-haspopup/)
})
test('四个组件源码不含 dangerouslySetInnerHTML；样式只用 --teloa- 令牌且无裸色',async()=>{
 for(const name of ['ObjectPageHeader.tsx','StatusBox.tsx','EventTimeline.tsx','PropertyRail.tsx'])assert.doesNotMatch(await source(name),/dangerouslySetInnerHTML/,name)
 const styles=await source('ObjectPage.module.css')
 assert.doesNotMatch(styles,/var\((?!--teloa-)/)
 assert.doesNotMatch(styles,/#[0-9a-f]{3,8}\b/i)
 for(const cls of ['header','back','titleRow','titleButton','badge','info','warn','good','muted','badges','owner','menuTrigger','menu','statusBox','sentence','hint','statusActions','primary','secondary','timeline','empty','events','event','pending','fold','icon','line','toggle','detail','rail','row','railLink','railDetail','mono'])assert.match(styles,new RegExp('\\.'+cls+'[\\s{,:>\\[]'),cls)
})
