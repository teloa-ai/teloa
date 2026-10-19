import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import type {WorkbenchView} from '../src/client/store.ts'
import type {WorkbenchNavigationState} from '../src/client/workbench-navigation-state.ts'
import {
 CENTER_MIN,RIGHTBAR_DEFAULT_RATIO,RIGHTBAR_KEYBOARD_STEP,RIGHTBAR_MIN,RIGHTBAR_DOCKED_MIN_VIEWPORT,RIGHTBAR_WIDTH_KEY,
 clampRightbarWidth,collapseRightbarForDirectory,defaultRightbarWidth,directoryNeedsRoom,directoryShown,groupPanelReport,directoryTrackWidth,navigationTrackWidth,
 readRightbarWidth,resizeRightbarWidth,rightbarCanShow,rightbarDirectoryForOpening,rightbarHandleVisible,rightbarTrackWidth,rightbarWidthRange,
 stepRightbarWidth,writeRightbarWidth,
} from '../src/client/rightbar-width.ts'

const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
const css=await readFile(new URL('../src/client/WorkbenchFrame.module.css',import.meta.url),'utf8')
const tokens=await readFile(new URL('../src/client/theme-tokens.module.css',import.meta.url),'utf8')

test('宽度契约取 DSH ui-layout 的常量而不是自定值',()=>{
 assert.equal(RIGHTBAR_MIN,300)
 assert.equal(CENTER_MIN,400)
 assert.equal(RIGHTBAR_DEFAULT_RATIO,0.45)
 assert.equal(RIGHTBAR_WIDTH_KEY,'teloa-details-width')
 assert.equal(RIGHTBAR_KEYBOARD_STEP,16)
 assert.equal(RIGHTBAR_DOCKED_MIN_VIEWPORT,CENTER_MIN+RIGHTBAR_MIN)
})

test('轨道占用按现行断点计算，窄屏的导航与目录都是覆盖层不占轨道',()=>{
 assert.equal(navigationTrackWidth(1440),204)
 assert.equal(navigationTrackWidth(1080),0)
 assert.equal(directoryTrackWidth(1680,true),296)
 assert.equal(directoryTrackWidth(1440,true),280)
 assert.equal(directoryTrackWidth(1200,true),260)
 assert.equal(directoryTrackWidth(900,true),264)
 assert.equal(directoryTrackWidth(700,true),0)
 assert.equal(directoryTrackWidth(1440,false),0)
})

test('停靠模式的上限同时受 70% 与中栏 400px 约束',()=>{
 // 1440 - 204 导航 - 280 目录 - 400 中栏 = 556；70% = 1008，取小
 assert.deepEqual(rightbarWidthRange(1440,true),{min:300,max:556})
 // 关掉会话目录后中栏让出 280
 assert.deepEqual(rightbarWidthRange(1440,false),{min:300,max:836})
 // 窄桌面同样保留中栏 400px 与真实目录列宽
 assert.deepEqual(rightbarWidthRange(1200,true),{min:300,max:336})
 // 视口极窄时下限优先，range 退化成一个点
 assert.deepEqual(rightbarWidthRange(390,false),{min:300,max:300})
})

test('默认宽度只取视口 45%，不带当前布局的夹子',()=>{
 // 夹一律留到渲染期，默认值本身不能被"此刻会话目录开着"写死，否则换个布局就回不到 45%。
 assert.equal(defaultRightbarWidth(1440),648)
 assert.equal(defaultRightbarWidth(390),176)
})

test('存储读回的是用户偏好：上限不夹，只挡住小于下限的脏值',()=>{
 assert.equal(readRightbarWidth({getItem:()=>'520'},1440),520)
 // 900 在 1440+目录 的布局里放不下，但偏好要原样留着，换回宽布局才能回到 900。
 assert.equal(readRightbarWidth({getItem:()=>'900'},1440),900)
 assert.equal(readRightbarWidth({getItem:()=>'12'},1440),300)
 assert.equal(readRightbarWidth({getItem:()=>'abc'},1440),648)
 assert.equal(readRightbarWidth({getItem:()=>null},1440),648)
 const written:Array<[string,string]>=[]
 writeRightbarWidth({setItem:(k,v)=>{written.push([k,v])}},520)
 assert.deepEqual(written,[['teloa-details-width','520']])
})

test('偏好无损：视口与会话目录来回切换后宽度能回到原值',()=>{
 const preferred=readRightbarWidth({getItem:()=>'700'},1920)
 assert.equal(rightbarTrackWidth(preferred,1920,false),700)
 assert.equal(rightbarTrackWidth(preferred,1600,false),700)
 // 1600 开目录时 1600-204-296-400=700，仍恰好放得下；开关目录不该把偏好磨掉
 assert.equal(rightbarTrackWidth(preferred,1600,true),700)
 assert.equal(rightbarTrackWidth(preferred,1440,true),556)
 assert.equal(rightbarTrackWidth(preferred,1920,false),700)
})

test('窄桌面工作概览按实际可用列宽夹取，不覆盖会话',()=>{
 assert.equal(rightbarTrackWidth(540,1200,true),336)
 assert.equal(rightbarTrackWidth(346,768,false),346)
 assert.equal(rightbarTrackWidth(346,740,false),340)
 assert.equal(rightbarTrackWidth(999,860,false),460)
 assert.equal(rightbarTrackWidth(999,560,false),300)
})

test('空间不足时 canShow 收起概览，而非返回可覆盖输入的宽度',()=>{
 assert.equal(rightbarCanShow(1440,true,520),true)
 assert.equal(rightbarCanShow(1440,true,560),false)
 assert.equal(rightbarCanShow(1200,true,336),true)
 assert.equal(rightbarCanShow(900,true,300),false)
 assert.equal(rightbarCanShow(700,false,300),true)
 assert.equal(rightbarCanShow(699,false,300),false)
 assert.equal(rightbarCanShow(390,false,300),false)
})

test('打开右栏时目录让出窄桌面空间，963px 不再因差一像素拒绝打开',()=>{
 for(const viewport of [768,900,963,1081,1163]){
  const directory=rightbarDirectoryForOpening(viewport,true)
  assert.equal(directory,false,`${viewport}px 应让出目录空间`)
  assert.equal(rightbarCanShow(viewport,directory,rightbarTrackWidth(9999,viewport,directory)),true)
 }
 for(const viewport of [964,1080,1164,1440,1920])assert.equal(rightbarDirectoryForOpening(viewport,true),true,`${viewport}px 足够时保留目录`)
 for(const viewport of [390,740,767])assert.equal(rightbarDirectoryForOpening(viewport,true),true,'不改变原生小窗口全屏契约')
 assert.equal(rightbarDirectoryForOpening(963,false),false)
})

test('目录让位只在渲染期派生：本人目录选择不变，面板收起或放宽后原目录回来',()=>{
 const none={rightbar:false,groupPanel:false},rail={rightbar:true,groupPanel:false},group={rightbar:false,groupPanel:true}
 assert.equal(directoryShown(963,true,rail),false,'963px 概览打开时让出目录')
 assert.equal(directoryShown(963,true,none),true,'概览收起后原目录回来')
 assert.equal(directoryShown(1440,true,rail),true,'空间足够时目录与概览并存')
 assert.equal(directoryShown(963,false,none),false,'本人关闭的目录不会被面板打开')
 // 群侧栏按原型 platform-preview.css：≤1450px 打开时目录让位。
 for(const viewport of [741,963,1100,1381,1440,1450])assert.equal(directoryShown(viewport,true,group),false,viewport+'px 群面板打开时让出目录')
 for(const viewport of [1451,1600,1920])assert.equal(directoryShown(viewport,true,group),true,viewport+'px 群面板与目录并存')
 for(const viewport of [390,740])assert.equal(directoryShown(viewport,true,group),true,'窄屏目录是本人打开的覆盖层，不随面板让位')
 assert.equal(directoryNeedsRoom(963,rail),true);assert.equal(directoryNeedsRoom(1440,rail),false)
 assert.equal(directoryNeedsRoom(1440,group),true);assert.equal(directoryNeedsRoom(1600,group),false);assert.equal(directoryNeedsRoom(963,none),false)
})

test('群侧栏上报按群身份撤回：旧群迟到的关闭不覆盖新群',()=>{
 assert.equal(groupPanelReport(undefined,'a',true),'a')
 assert.equal(groupPanelReport('b','a',false),'b','切到 B 后 A 的卸载回调不清掉 B')
 assert.equal(groupPanelReport('a','a',false),undefined)
})

test('本人打开目录只经公开导航接口收起本会话右栏，不关页签',()=>{
 let toggles=0
 const face=(expanded:boolean,mounted='s1')=>({mounted:{getSnapshot:()=>mounted,subscribe:()=>()=>{}},isExpanded:()=>expanded,toggleExpanded:()=>{toggles++}})
 assert.equal(collapseRightbarForDirectory(face(true) as never,'s1'),true);assert.equal(toggles,1)
 assert.equal(collapseRightbarForDirectory(face(false) as never,'s1'),false,'已收起不再切换')
 assert.equal(collapseRightbarForDirectory(face(true,'other') as never,'s1'),false,'不收起其他会话的右栏')
 assert.equal(collapseRightbarForDirectory(undefined,'s1'),false);assert.equal(collapseRightbarForDirectory(face(true) as never,undefined),false)
 assert.equal(toggles,1)
})

test('工作台不再因让位改写本人目录选择，目录入口按实际可见状态响应',()=>{
 assert.doesNotMatch(frame,/actions\.closeSidebar\(\)\s*\},\[railShown/,'让位不能调用 closeSidebar')
 assert.match(frame,/const directoryVisible=directoryShown\(viewportWidth,state\.directoryOpen,directoryOccupants\)/)
 assert.match(frame,/aria-expanded=\{directoryVisible\}/)
 assert.match(frame,/state\.view==='messages'&&directoryVisible&&/)
})

test('喂给 DSH 的 canShow 取轨道实际宽度，任何偏好都不会让 RightbarSeat 关栏',()=>{
 // DSH RightbarSeat 在 useLayoutEffect 里见到 canShow 为假会 setExpanded(false)，
 // 而 layout effect 早于父组件的 passive effect，所以真源必须在渲染期就夹好。
 for(const viewportWidth of [1381,1440,1600,1920,2560])for(const directoryOpen of [true,false]){
  const width=rightbarTrackWidth(9999,viewportWidth,directoryOpen)
  assert.equal(rightbarCanShow(viewportWidth,directoryOpen,width),true,`${viewportWidth}/${directoryOpen}`)
 }
})

test('把手只在停靠模式出现',()=>{
 assert.equal(rightbarHandleVisible(1440),true)
 assert.equal(rightbarHandleVisible(1381),true)
 assert.equal(rightbarHandleVisible(1380),true)
 assert.equal(rightbarHandleVisible(700),true)
 assert.equal(rightbarHandleVisible(699),false)
})

test('向左拖变宽，键盘左右箭头各走 16px，其它按键不改宽度',()=>{
 assert.equal(resizeRightbarWidth(400,-60,1440,true),460)
 assert.equal(resizeRightbarWidth(400,60,1440,true),340)
 assert.equal(resizeRightbarWidth(400,-1000,1440,true),556)
 assert.equal(stepRightbarWidth(400,'ArrowLeft',1440,true),400+RIGHTBAR_KEYBOARD_STEP)
 assert.equal(stepRightbarWidth(400,'ArrowRight',1440,true),400-RIGHTBAR_KEYBOARD_STEP)
 assert.equal(stepRightbarWidth(400,'Enter',1440,true),null)
 // Home/End 直达当前范围两端，Enter 交回组件当作"恢复默认"处理
 assert.equal(stepRightbarWidth(400,'Home',1440,true),300)
 assert.equal(stepRightbarWidth(400,'End',1440,true),556)
})

test('clamp 把任何宽度压回当前 range',()=>{
 assert.equal(clampRightbarWidth(10,1440,true),300)
 assert.equal(clampRightbarWidth(9999,1440,true),556)
 // 拖拽会产生小数像素，真源必须只保存整数，避免存储与 CSS 变量来回抖动。
 assert.equal(clampRightbarWidth(520.4,1440,true),520)
})

test('轨道折叠改 width:0，不再用 display:none，也不再由 Teloa 写 hidden/aria-hidden',()=>{
 assert.match(css,/\.details\{[^}]*width:0[^}]*overflow:hidden/)
 assert.doesNotMatch(css,/\.details\{[^}]*display:none/)
 assert.match(css,/\.detailsOpen \.details\{[^}]*width:var\(--teloa-details-width/)
 assert.doesNotMatch(frame,/className=\{css\.details\}[^>]*hidden=/)
 assert.doesNotMatch(frame,/className=\{css\.details\}[^>]*aria-hidden=/)
})

test('收起态轨道必须是定位元素，否则 overflow:hidden 裁不住绝对定位的 DSH 面板',()=>{
 // 实测：离开会话页时 Teloa 把轨道收成 0，DSH 仍按展开态渲染 position:absolute 的面板；
 // 轨道不是定位元素时它的包含块是 .columns，收起态的 overflow:hidden 不生效，
 // 面板继续压在主列上并吃掉点击（设置页语言与外观整块点不到）。
 assert.match(css,/\.details\{[^}]*position:relative/)
})

test('收起态轨道裁住 fixed 后代，展开态恢复原生右栏浮层',()=>{
 // DSH 文件预览会留下 fixed 定位的 textDocument。单靠 width:0 + overflow:hidden 裁不住 fixed 后代，
 // 它会越过手机会话目录继续显示并吃掉目录行点击；paint containment 让零宽轨道成为它的包含块。
 assert.match(css,/\.details\{[^}]*contain:paint/)
 assert.match(css,/\.detailsOpen \.details\{[^}]*contain:none/)
})

test('宽度只有一个真源：380 这个字面量在轨道与 renderSlot 两处都消失',()=>{
 assert.doesNotMatch(css,/\.details\{[^}]*width:380px/)
 assert.doesNotMatch(frame,/renderSlot\('rightbar',\{width:380/)
 assert.match(frame,/renderSlot\('rightbar',\{width:detailsWidth,viewportWidth,canShow:detailsCanShow\}\)/)
})

test('z-index 全部走令牌，Teloa 浮层在 DSH fullscreen 之上、移动端导航在 DSH 浮动面板之上',()=>{
 assert.match(tokens,/--teloa-z-column-overlay:20/)
 assert.match(tokens,/--teloa-z-menu:24/)
 assert.match(tokens,/--teloa-z-column-overlay-narrow:25/)
 assert.match(tokens,/--teloa-z-shell-overlay:45/)
 assert.match(tokens,/--teloa-z-nav-menu:65/)
 assert.match(tokens,/--teloa-z-nav-mask:70/)
 assert.match(tokens,/--teloa-z-navigation:71/)
 assert.match(tokens,/--teloa-z-skip:100/)
 for(const literal of ['z-index:20','z-index:24','z-index:25','z-index:30','z-index:41','z-index:42','z-index:48','z-index:100'])assert.doesNotMatch(css,new RegExp(literal.replace('-','\\-')))
})

test('概览保持非模态并栏，不再随窄桌面断点绝对定位覆盖输入',()=>{
 assert.doesNotMatch(css,/width:420px/)
 assert.doesNotMatch(css,/max-width:70vw/)
 assert.doesNotMatch(css,/\.detailsOpen \.details\{[^}]*position:absolute/)
 assert.match(frame,/const detailsWidth=rightbarTrackWidth\(detailsPreferred,viewportWidth,detailsDirectoryOpen\)/)
})

test('宽度在渲染期从偏好派生，不留"下一帧再夹"的 effect',()=>{
 // 夹一旦落到 useEffect，DSH RightbarSeat 的 useLayoutEffect 会先拿旧宽度把右栏关掉。
 assert.doesNotMatch(frame,/setDetailsWidth/)
 assert.match(frame,/const \[detailsPreferred,setDetailsPreferred\]=useState\(\(\)=>readRightbarWidth\(localStorage,window\.innerWidth\)\)/)
})

test('把手压过 DSH 面板的 z-index:10，拖拽期由 .dragging 抑制选区',()=>{
 assert.match(tokens,/--teloa-z-rightbar-handle:11/)
 assert.match(css,/\.detailsHandle\{[^}]*z-index:var\(--teloa-z-rightbar-handle\)/)
 assert.match(css,/\.dragging,\.dragging \*\{user-select:none\}/)
 assert.match(frame,/detailsDragging&&css\.dragging/)
})

test('拖拽走指针捕获，监听挂把手而不是 window，并跟随最新布局',()=>{
 assert.match(frame,/handle\.setPointerCapture\(event\.pointerId\)/)
 assert.match(frame,/handle\.addEventListener\('pointercancel',stop\)/)
 assert.doesNotMatch(frame,/window\.addEventListener\('pointermove'/)
 assert.doesNotMatch(frame,/window\.addEventListener\('pointerup'/)
 assert.match(frame,/if\(event\.button!==0\)return/)
 assert.match(frame,/const layout=detailsLayout\.current/)
 assert.match(frame,/useEffect\(\(\)=>\(\)=>\{stopDetailsDrag\.current\?\.\(\)\},\[\]\)/)
 // pointerdown 不再 preventDefault，否则把手拿不到焦点就接不上键盘调节
 assert.match(frame,/handle\.focus\(\)/)
 assert.doesNotMatch(frame,/const dragDetails=[\s\S]{0,80}event\.preventDefault\(\)/)
})

test('把手是带值的 separator，aria-controls 指向它调的轨道，Enter 等价于双击',()=>{
 assert.match(frame,/id=\{DETAILS_TRACK_ID\} role="region" hidden=\{!conversationVisible&&!artifactRailShown\|\|builderVisible\} className=\{clsx\(css\.details,artifactRailShown&&css\.artifactDetails\)\}/)
 assert.match(frame,/aria-controls=\{DETAILS_TRACK_ID\} aria-valuenow=\{detailsWidth\} aria-valuemin=\{detailsRange\.min\} aria-valuemax=\{detailsRange\.max\}/)
 assert.match(frame,/if\(event\.key==='Enter'\)\{event\.preventDefault\(\);restoreDetailsWidth\(\)/)
})

test('原生折叠态仍由 DSH 面板负责，首页、群与目录隐藏整条上一会话轨道',()=>{
 // 依赖 @deepseek-ai/dsh-client-ui-sidebar-right 的 .panel：它是 visibility:hidden，
 // 展开才加 [data-sidebar-right-open]{visibility:visible}，并写 aria-hidden={!expanded}。
 // 该包不在本包依赖里，无法直接断言其源码；这里改为钉住 Teloa 侧的前提——
 // 原生工具与成果各有座位；成果占用备用座位时隐藏原生工具，不泄露上一会话。
 const track=frame.split('id={DETAILS_TRACK_ID}')[1]!.split('        </div>')[0]!
 assert.match(track,/renderSlot\('rightbar'/)
 assert.match(track,/hidden=\{!conversationVisible&&!artifactRailShown\|\|builderVisible\}/,'首页、群与目录不暴露上一原生会话工具')
 assert.doesNotMatch(track,/hidden=\{!?railShown\}/,'不覆盖 DSH 自己的展开/折叠状态')
 assert.match(track,/className=\{css\.nativeRail\} hidden=\{artifactFallbackShown\}/)
 assert.match(track,/className=\{css\.artifactMount\} hidden=\{!artifactFallbackShown\}/)
 assert.equal(track.split('<').filter(part=>part.startsWith('button')||part.startsWith('div')||part.startsWith('section')).length,3)
 // 执行实际 Frame 的纯展示守卫，不能仅因它们的名字存在就认定旧会话已被隐藏。
 const source=ts.createSourceFile('WorkbenchFrame.tsx',frame,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),initializers=new Map<string,ts.Expression>(),names=new Set(['conversationVisible','nativeMainVisible','nativeRailShown','groupArtifactShown','artifactRailShown','railShown'])
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&names.has(node.name.text)&&node.initializer){assert.equal(initializers.has(node.name.text),false,'展示守卫必须唯一');initializers.set(node.name.text,node.initializer)}ts.forEachChild(node,visit)}
 visit(source);for(const name of names)assert.ok(initializers.has(name),name)
 const hidden=track.match(/hidden=\{([^}]+)\}/)?.[1];assert.ok(hidden)
 type State=Pick<WorkbenchNavigationState,'messageMode'>&{view:WorkbenchView;rightbar:{shown:boolean};groupTarget?:{groupId:string}}
 const presentation=new Function('state','nativePanelVisible','builderVisible','artifactOpen','groupArtifactSeat',`const conversationVisible=${initializers.get('conversationVisible')!.getText(source)};const nativeMainVisible=${initializers.get('nativeMainVisible')!.getText(source)};const nativeRailShown=${initializers.get('nativeRailShown')!.getText(source)};const groupArtifactShown=${initializers.get('groupArtifactShown')!.getText(source)};const artifactRailShown=${initializers.get('artifactRailShown')!.getText(source)};const railShown=${initializers.get('railShown')!.getText(source)};return {nativeMainVisible,railShown,hidden:${hidden}}`) as (state:State,nativePanelVisible:boolean,builderVisible:boolean,artifactOpen?:boolean,groupArtifactSeat?:{groupId:string})=>{nativeMainVisible:boolean;railShown:boolean;hidden:boolean}
 for(const view of ['home','attention','tasks','plans','projects','team','spaces','market','resources','settings'] as const){
  const value=presentation({view,messageMode:'native',rightbar:{shown:true}},false,false)
  assert.equal(value.hidden,true,view+' 不暴露上一会话右栏');assert.equal(value.railShown,false,view+' 不展示上一会话停靠轨道')
  if(view==='home')assert.equal(value.nativeMainVisible,true,'首页可复用原生输入，但不因此显示会话右栏')
 }
 for(const messageMode of ['directory','groups'] as const)assert.deepEqual(presentation({view:'messages',messageMode,rightbar:{shown:true}},false,false),{nativeMainVisible:false,railShown:false,hidden:true},messageMode+' 保留旧会话状态也不能显示其右栏')
 assert.deepEqual(presentation({view:'messages',messageMode:'native',rightbar:{shown:false}},false,false),{nativeMainVisible:true,railShown:false,hidden:false},'原会话收起仍交由 DSH 的 seat 管理，不隐藏整条挂载轨道')
 assert.deepEqual(presentation({view:'messages',messageMode:'native',rightbar:{shown:true}},false,false),{nativeMainVisible:true,railShown:true,hidden:false},'原会话可正常展开工作概览')
 assert.equal(presentation({view:'messages',messageMode:'native',rightbar:{shown:true}},false,true).hidden,true,'业务构建视图不能暴露上一会话右栏')
 assert.deepEqual(presentation({view:'projects',messageMode:'native',rightbar:{shown:false}},false,false,true),{nativeMainVisible:false,railShown:true,hidden:false},'项目成果可独立使用同一右栏，不显示上一原生会话')
 assert.equal(presentation({view:'projects',messageMode:'native',rightbar:{shown:false}},false,true,true).hidden,true,'搭建预览仍隐藏成果轨道')
 assert.deepEqual(presentation({view:'messages',messageMode:'native',rightbar:{shown:true}},true,false),{nativeMainVisible:true,railShown:false,hidden:true},'原生设置等面板仍可显示主列，但隔离原会话右栏')
})
