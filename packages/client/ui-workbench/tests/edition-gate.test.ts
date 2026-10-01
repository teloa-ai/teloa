import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {configureEdition,createEditionApi,editionGateProps,interceptEditionGateClick,interceptEditionGateKey,readEdition,resetEdition} from '../src/client/edition.ts'

const source=await readFile(new URL('../src/client/EditionGate.tsx',import.meta.url),'utf8')
const gateEvent=()=>{const seen={prevented:false,stopped:false};return {seen,event:{key:'Enter',preventDefault:()=>{seen.prevented=true},stopPropagation:()=>{seen.stopped=true}}}}

test('门控接管点击与 Enter/空格：只打开提示，被包裹控件的处理函数不可能被调用',()=>{
 let wrapped=0,opened=0
 const original=()=>{wrapped++}
 const props=editionGateProps('business-space-create',()=>{opened++})
 assert.equal(props['aria-disabled'],true)
 assert.equal(props['data-edition-gate'],'business-space-create')
 assert.notEqual(props.onClick,original)
 assert.notEqual(props.onKeyDown,original)
 const click=gateEvent();props.onClick(click.event as never)
 assert.deepEqual([wrapped,opened,click.seen.prevented,click.seen.stopped],[0,1,true,true])
 props.onKeyDown(gateEvent().event as never)
 props.onKeyDown({...gateEvent().event,key:' '} as never)
 assert.deepEqual([wrapped,opened],[0,3])
 const arrow=gateEvent()
 props.onKeyDown({...arrow.event,key:'ArrowDown'} as never)
 assert.deepEqual([opened,arrow.seen.prevented,arrow.seen.stopped],[3,false,false])
})

test('拦截函数一律吞掉事件；方向键不算激活',()=>{
 let opened=0
 const click=gateEvent()
 interceptEditionGateClick(click.event,()=>{opened++})
 assert.deepEqual([opened,click.seen.prevented,click.seen.stopped],[1,true,true])
 const arrow=gateEvent()
 assert.equal(interceptEditionGateKey({...arrow.event,key:'ArrowDown'},()=>{opened++}),false)
 assert.equal(interceptEditionGateKey(gateEvent().event,()=>{opened++}),true)
 assert.equal(opened,2)
})

test('个人版下渲染原控件并标 aria-disabled，非个人版原样透传，提示带必填 label',()=>{
 assert.match(source,/const edition=useEdition\(\)/,'版本只从 useEdition 读，没有可旁路的属性')
 assert.doesNotMatch(source,/edition\?:/,'门控不接受调用方传入的版本')
 assert.match(source,/if\(edition!=='personal'\)return children/,'非个人版必须原样透传')
 assert.match(source,/cloneElement\(children as ReactElement<Record<string,unknown>>,editionGateProps\(feature,/,'个人版下由门控接管控件属性')
 assert.match(source,/feature:string;label:string;onIntercept\?:\(\)=>void;children:ReactElement/,'label 是必填 prop，不能省略')
 assert.doesNotMatch(source,/call\(|Api\./,'门控不发任何请求')
})

test('提示是自动消失的非模态小提示：role="status"，不再有 dialog / openDialog',()=>{
 assert.doesNotMatch(source,/<dialog|openDialog|dialog-focus/,'不再使用模态 dialog 或它的焦点管理')
 assert.match(source,/role="status"/,'提示必须是非模态的 status 区域')
 assert.match(source,/aria-live="polite"/,'非模态提示用 aria-live 播报，不抢焦点')
 assert.match(source,/t\('edition\.gate\.body',\{action:label\}\)/,'提示文案必须带调用方传入的动作名')
})

test('提示按 NOTICE_DURATION_MS 自动关闭，再次触发只重置计时不叠加',()=>{
 assert.match(source,/const NOTICE_DURATION_MS=4000/,'停留时长固定，方便一处调整')
 // show() 每次都先清掉上一个 timer 再重新计时：多次触发只重置倒计时，不会叠加出多个待触发的关闭。
 assert.match(source,/const show=\(\)=>\{clearTimer\(\);setPhase\('open'\);timer\.current=setTimeout\(leave,NOTICE_DURATION_MS\)\}/)
 assert.match(source,/const leave=\(\)=>\{clearTimer\(\);setPhase\('leaving'\)/,'到时或点击都统一走 leave，不会有第二条并存的关闭逻辑')
})

test('点击提示本身立即触发关闭（进入 leaving，不需要额外的关闭按钮）',()=>{
 assert.match(source,/onClick=\{leave\}/,'点击提示直接触发关闭，不用等计时')
 assert.doesNotMatch(source,/<button[^>]*aria-label=\{t\('edition\.gate\.close'\)\}/,'不再需要专门的关闭按钮')
})

test('提示挂到 document.body，不污染菜单容器',()=>{
 assert.match(source,/createPortal\(notice,document\.body\)/)
})

test('版本回包严格读取：只认 personal，多余键与其它取值一律拒绝',async()=>{
 assert.equal(readEdition({edition:'personal'}),'personal')
 assert.throws(()=>readEdition({edition:'enterprise'}),/格式不正确/)
 assert.throws(()=>readEdition({edition:'personal',trial:true}),/格式不正确/)
 assert.throws(()=>readEdition({}),/格式不正确/)
 assert.throws(()=>readEdition('personal'),/格式不正确/)
 const sent:Array<[string,unknown]>=[]
 const api=createEditionApi(async(endpoint,payload)=>{sent.push([endpoint,payload]);return {edition:'personal'}})
 assert.equal(await api.read(),'personal')
 assert.deepEqual(sent,[['app/edition',{}]])
})

test('门控提示挂到页面层级；市场加载表单这一处调用点仍传了 label',async()=>{
 const page=await readFile(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8')
 const industryLoad=await readFile(new URL('../src/client/IndustryLoadForm.tsx',import.meta.url),'utf8')
 // 提示用 portal 挂到 document.body：菜单里不会多出一个非 menuitem 的元素。
 assert.match(source,/onIntercept\?\.\(\);show\(\)/,'打开提示前先给调用方收起菜单的机会')
 // 第二期：业务范围内页摘掉了「管理」菜单，business-space-create 只剩特性键本身（下一条用例直接验它）。
 assert.doesNotMatch(page,/EditionGate|data-space-menu-index/)
 assert.match(industryLoad,/<EditionGate feature="industry-load-new-space" label=\{t\('edition\.gate\.feature\.newSpace'\)\}>/)
})

test('space-switcher 特性键留给企业版：不再挂在 WorkNavigation 上，但门控逻辑本身照样接管它',()=>{
 // 个人版壳层已经去掉空间切换器，space-switcher 只是保留给企业版复用的特性键；
 // 直接用 editionGateProps（EditionGate 内部真正接管控件属性所用的函数）验证这个 feature 还能被正常接管，
 // 不必再读 WorkNavigation.tsx 的源码去找这一行。
 let opened=0
 const props=editionGateProps('space-switcher',()=>{opened++})
 assert.equal(props['aria-disabled'],true)
 assert.equal(props['data-edition-gate'],'space-switcher')
 const click=gateEvent();props.onClick(click.event as never)
 assert.deepEqual([opened,click.seen.prevented,click.seen.stopped],[1,true,true])
})

test('版本读不到时降级为个人版并记录错误，不抛给界面',async()=>{
 resetEdition()
 const errors:unknown[]=[]
 const original=console.error
 console.error=(...args:unknown[])=>{errors.push(args)}
 try{
  const api={read:async()=>{throw Object.assign(Error('offline'),{rejected:true,code:'teloa/dependency-unavailable'})}}
  assert.equal(await configureEdition(api),'personal')
  // 读一次：第二次调用复用同一个缓存 Promise，不再发请求。
  let calls=0
  assert.equal(await configureEdition({read:async()=>{calls++;return 'personal' as const}}),'personal')
  assert.equal(calls,0)
 }finally{console.error=original;resetEdition()}
 assert.equal(errors.length,1)
})
