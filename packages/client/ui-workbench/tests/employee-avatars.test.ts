import assert from 'node:assert/strict'
import test from 'node:test'
import {ROLE_AVATAR_KEYS,ROLE_AVATAR_PRESETS} from '../../../contract/src/roles.ts'
import {mount,nodes} from './market-component-harness.ts'
import {employeeCopy} from '../src/client/employee-copy.ts'
const avatars=await import('../lib/types/client/employee-avatars.js')
const bot=await import('../lib/types/client/bot-avatar.js')

test('头像按形状 × 颜色绘制：预设沿用契约对照表，组合键按原样绘制，未设置或无法识别时回退通用形象',()=>{
 const {botAvatarPaint,botColors,teloaBotPaint}=bot
 assert.equal(Object.keys(botColors).includes('ink'),true,'最新在线稿包含墨黑')
 assert.deepEqual(teloaBotPaint,{shape:'star4',fill:'var(--teloa-bot-ink)',eye:'var(--teloa-bot-ink-eye)'},'Teloa 四角星颜色随主题令牌切换')
 for(const key of ROLE_AVATAR_KEYS){const [shape,color]=ROLE_AVATAR_PRESETS[key];assert.deepEqual(botAvatarPaint(key),{shape,fill:botColors[color],eye:'#FFFFFF'},key)}
 assert.deepEqual(botAvatarPaint('bot:ghost:amber'),{shape:'ghost',fill:botColors.amber,eye:'#FFFFFF'})
 for(const key of [undefined,'unknown-employee','bot:star:teal','bot:newshape:teal'])assert.deepEqual(botAvatarPaint(key),botAvatarPaint('general'),String(key))
 assert.match(decodeURIComponent(bot.botAvatarUri('bot:hexa:plum')),/fill="#8A4E86"/)
})

test('头像说明为「颜色 · 形状」，简体、繁体和英文均有名称，预设与等价组合描述相同',()=>{
 const {employeeAvatarName,avatarShapes,avatarColors,avatarShapeName,avatarColorName}=avatars
 assert.equal(avatarShapes.length,12);assert.equal(avatarColors.length,10)
 for(const locale of ['zh-CN','zh-TW','zh-HK','en']){
  for(const shape of avatarShapes)assert.ok(avatarShapeName(shape,locale),shape)
  for(const color of avatarColors)assert.ok(avatarColorName(color,locale),color)
 }
 assert.equal(employeeAvatarName('researcher','zh-CN'),'橄榄绿 · 豆形')
 assert.equal(employeeAvatarName('bot:bean:olive','zh-CN'),employeeAvatarName('researcher','zh-CN'))
 assert.equal(employeeAvatarName('bot:ghost:amber','zh-HK'),'琥珀 · 小幽靈')
 assert.equal(employeeAvatarName('bot:ghost:amber','en'),'Amber · Little ghost')
 assert.equal(employeeAvatarName(undefined,'en'),'Warm gray · Circle')
})

function picker(value:string|undefined,name?:string){
 let picked:string|undefined
 const ui=mount('EmployeeAvatarPicker.tsx',{'./employee-avatars.js':avatars,'./bot-avatar.js':bot,'./employee-copy.js':{employeeCopy}})
 const tree=nodes(ui.render('EmployeeAvatarPicker',{value,name,onChange:(key:string)=>{picked=key}}))
 const group=(label:string)=>tree.find(node=>node.props.role==='radiogroup'&&node.props['aria-labelledby']===tree.find(item=>item.children.includes(label))?.props.id)!
 const radios=(label:string)=>nodes(group(label)).filter(node=>node.props.role==='radio')
 return {tree,picked:()=>picked,shapes:()=>radios(employeeCopy('en','avatarShape')),colors:()=>radios(employeeCopy('en','avatarColor'))}
}

test('选择器：大预览与名字，下面形状一行 12 个、色板一行 10 个，包含墨黑；未设置时显示通用形象且不回传',()=>{
 const ui=picker(undefined,'  Ada  ')
 assert.ok(ui.tree.some(node=>node.type==='strong'&&node.children.includes('Ada')))
 assert.ok(ui.tree.some(node=>node.type==='small'&&node.children.includes('Warm gray · Circle')))
 assert.equal(ui.shapes().length,12);assert.equal(ui.colors().length,10)
 assert.equal(ui.colors().some(node=>node.props['aria-label']==='Ink'||/23211E/i.test(String(node.props.style?.background))),true)
 assert.deepEqual(ui.shapes().filter(node=>node.props['aria-checked']).map(node=>node.props['aria-label']),['Circle'])
 assert.deepEqual(ui.colors().filter(node=>node.props['aria-checked']).map(node=>node.props['aria-label']),['Warm gray'])
 assert.equal(ui.shapes().filter(node=>node.props.tabIndex===0).length,1,'单选组只有选中项可 Tab 进入')
 assert.equal(ui.picked(),undefined)
 assert.ok(picker(undefined,'  ').tree.some(node=>node.type==='strong'&&node.children.includes(employeeCopy('en','avatarUnnamed'))))
})

test('选择器：换形状或颜色回传组合键，等于预设时回传旧键；方向键循环选择',()=>{
 const ui=picker('researcher')
 assert.deepEqual(ui.shapes().filter(node=>node.props['aria-checked']).map(node=>node.props['aria-label']),['Bean'])
 ui.shapes().find(node=>node.props['aria-label']==='Little ghost')!.props.onClick()
 assert.equal(ui.picked(),'bot:ghost:olive')
 ui.colors().find(node=>node.props['aria-label']==='Indigo')!.props.onClick()
 assert.equal(ui.picked(),'bot:bean:indigo')
 const combo=picker('bot:ghost:amber')
 combo.shapes().find(node=>node.props['aria-label']==='Bean')!.props.onClick()
 assert.equal(combo.picked(),'recruiter','豆形 × 琥珀等于招聘预设，回传旧键')
 combo.colors().find(node=>node.props['aria-label']==='Teal')!.props.onClick()
 assert.equal(combo.picked(),'ui-designer','小幽灵 × 青绿等于 UI 设计师预设')
 const key=(name:string)=>({key:name,preventDefault(){},currentTarget:{parentElement:null}})
 const last=combo.shapes().at(-1)!
 last.props.onKeyDown(key('ArrowRight'));assert.equal(combo.picked(),'bot:circle:amber','形状行末尾按右键回到第一个')
 combo.colors()[0]!.props.onKeyDown(key('ArrowLeft'));assert.equal(combo.picked(),'bot:ghost:ink','色板行首按左键到最后一个')
 combo.colors()[0]!.props.onKeyDown(key('Tab'));assert.equal(combo.picked(),'bot:ghost:ink','其他按键不改变选择')
})
