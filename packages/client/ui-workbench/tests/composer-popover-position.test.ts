import test from 'node:test'
import assert from 'node:assert/strict'
import {composerPopoverPosition,composerSubmenuPosition} from '../src/client/composer-popover-position.ts'

test('输入框菜单优先贴近触发按钮上方，保留 8px 间隙',()=>{
 assert.deepEqual(composerPopoverPosition({left:300,top:500,bottom:534},320,200,1280,900),{left:300,top:292,width:320,maxHeight:480})
})
test('顶部不够时翻到下方；右侧和手机宽度按视口避让',()=>{
 const below=composerPopoverPosition({left:950,top:100,bottom:136},360,280,1100,800)
 assert.equal(below.top,144);assert.equal(below.left,728)
 const phone=composerPopoverPosition({left:300,top:400,bottom:444},360,320,390,844)
 assert.equal(phone.left,18);assert.equal(phone.width,360)
 const tiny=composerPopoverPosition({left:200,top:300,bottom:336},360,500,320,600)
 assert.equal(tiny.width,296);assert.equal(tiny.left,12);assert.ok(tiny.top>=12);assert.ok(tiny.top+tiny.maxHeight<=588)
})
test('窗口缩放后按新视口重新计算，菜单不能跑出屏幕',()=>{
 const pos=composerPopoverPosition({left:400,top:700,bottom:736},360,480,400,500)
 assert.ok(pos.left+pos.width<=388);assert.ok(pos.top+pos.maxHeight<=488)
})
test('子菜单在分类旁展开，右侧不足则向左；上下均不越界',()=>{
 assert.deepEqual(composerSubmenuPosition({left:200,right:480,top:600},360,420,1280,900),{left:488,top:468,width:360,maxHeight:480})
 assert.equal(composerSubmenuPosition({left:760,right:1040,top:200},360,300,1280,900).left,392)
 const narrow=composerSubmenuPosition({left:300,right:580,top:20},360,800,800,600)
 assert.ok(narrow.left>=12);assert.ok(narrow.left+narrow.width<=788)
 assert.ok(narrow.top>=12);assert.ok(narrow.top+Math.min(800,narrow.maxHeight)<=588)
})
