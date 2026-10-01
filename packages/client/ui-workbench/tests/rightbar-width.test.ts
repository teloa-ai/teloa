import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {
 CENTER_MIN,RIGHTBAR_DEFAULT_RATIO,RIGHTBAR_KEYBOARD_STEP,RIGHTBAR_MIN,RIGHTBAR_OVERLAY_WIDTH,RIGHTBAR_WIDTH_KEY,
 clampRightbarWidth,defaultRightbarWidth,directoryTrackWidth,navigationTrackWidth,
 readRightbarWidth,resizeRightbarWidth,rightbarCanShow,rightbarHandleVisible,rightbarTrackWidth,rightbarWidthRange,
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
 assert.equal(RIGHTBAR_OVERLAY_WIDTH,420)
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
 // 覆盖模式（<=1380）不压中栏，只受 70% 约束
 assert.deepEqual(rightbarWidthRange(1200,true),{min:300,max:840})
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

test('覆盖模式的轨道宽度是固定抽屉，与 CSS 共用同一个数',()=>{
 // 1200 视口曾经出现"面板 540 溢出轨道 420"，现在两边都取这里的返回值
 assert.equal(rightbarTrackWidth(540,1200,true),420)
 assert.equal(rightbarTrackWidth(346,768,false),420)
 // 70% 上限在 600 这种窄屏会先于 420 生效之前先被"铺满"接管
 assert.equal(rightbarTrackWidth(346,740,false),740)
 assert.equal(rightbarTrackWidth(999,560,false),560)
 // 恰好 600 宽的覆盖抽屉：min(420, floor(600*0.7)=420)
 assert.equal(rightbarTrackWidth(999,860,false),420)
})

test('canShow 真算：中栏被压到 400 以下即为假，覆盖模式恒真',()=>{
 assert.equal(rightbarCanShow(1440,true,520),true)
 assert.equal(rightbarCanShow(1440,true,560),false)
 assert.equal(rightbarCanShow(1200,true,840),true)
 assert.equal(rightbarCanShow(390,false,300),true)
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
 assert.equal(rightbarHandleVisible(1380),false)
 assert.equal(rightbarHandleVisible(700),false)
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

test('覆盖模式不再有第二个宽度真源：420/70vw/100% 三处字面量都换成同一个变量',()=>{
 assert.doesNotMatch(css,/width:420px/)
 assert.doesNotMatch(css,/max-width:70vw/)
 assert.match(css,/@media\(max-width:1380px\)\{[^@]*\.detailsOpen \.details\{[^}]*width:var\(--teloa-details-width/)
 assert.match(frame,/const detailsWidth=rightbarTrackWidth\(detailsPreferred,viewportWidth,state\.directoryOpen\)/)
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
 assert.match(frame,/id=\{DETAILS_TRACK_ID\} role="region" className=\{css\.details\}/)
 assert.match(frame,/aria-controls=\{DETAILS_TRACK_ID\} aria-valuenow=\{detailsWidth\} aria-valuemin=\{detailsRange\.min\} aria-valuemax=\{detailsRange\.max\}/)
 assert.match(frame,/if\(event\.key==='Enter'\)\{event\.preventDefault\(\);restoreDetailsWidth\(\)/)
})

test('折叠态不入无障碍树由 DSH 面板负责：Teloa 只放把手与 rightbar 插槽，不自写 hidden',()=>{
 // 依赖 @deepseek-ai/dsh-client-ui-sidebar-right 的 .panel：它是 visibility:hidden，
 // 展开才加 [data-sidebar-right-open]{visibility:visible}，并写 aria-hidden={!expanded}。
 // 该包不在本包依赖里，无法直接断言其源码；这里改为钉住 Teloa 侧的前提——
 // 轨道里除了把手就只有 renderSlot('rightbar')，没有 Teloa 自己的可读内容。
 const track=frame.split('id={DETAILS_TRACK_ID}')[1]!.split('</div>')[0]!
 assert.match(track,/renderSlot\('rightbar'/)
 assert.doesNotMatch(track,/hidden=/)
 assert.equal(track.split('<').filter(part=>part.startsWith('button')||part.startsWith('div')||part.startsWith('section')).length,1)
})
