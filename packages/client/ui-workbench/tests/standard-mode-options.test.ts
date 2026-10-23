import assert from 'node:assert/strict'
import test from 'node:test'
import {presetDisplayName,standardModeDescription} from '../src/client/standard-mode-options.ts'

test('未发布名称的 DSH 内置预设按简繁英显示产品名，其余语言回退英文',()=>{
 assert.deepEqual(['ptc','minimal','cordis','standard'].map(id=>presetDisplayName({id},'zh-Hans')),['PTC 模式','极简模式','创造模式','标准模式'])
 assert.deepEqual(['ptc','minimal','cordis','standard'].map(id=>presetDisplayName({id},'zh-TW')),['PTC 模式','極簡模式','創造模式','標準模式'])
 assert.deepEqual(['ptc','minimal','cordis','standard'].map(id=>presetDisplayName({id},'en-GB')),['PTC mode','Minimal mode','Creator mode','Standard mode'])
 assert.equal(presetDisplayName({id:'minimal'},'ja'),'Minimal mode')
})

test('可选代码模式沿原选择器显示简繁英名称和说明，本人改名及说明保留',()=>{
 const persistent={id:'ptc-persistent',description:'Keep variables, functions and imported modules across run_code calls in this live agent runtime; memory is not persisted and clears on restart, cancellation, timeout or agent teardown.'},python={id:'ptc-python',description:'Run run_code with Python, using the current file permissions and approval rules.'}
 for(const locale of ['zh-Hans','zh-TW','en'])for(const option of [persistent,python]){
  assert.notEqual(presetDisplayName(option,locale),option.id)
  assert.ok(standardModeDescription(option,locale))
 }
 assert.match(presetDisplayName(persistent,'zh-TW'),/保留變數/);assert.match(standardModeDescription(python,'zh-TW')!,/檔案權限/)
 assert.match(standardModeDescription({...persistent,name:'ptc-persistent'},'zh-Hans')!,/保留变量/,'自定义预设名称是 id 时官方英文说明仍要按界面语言显示')
 assert.equal(presetDisplayName({...persistent,name:'本人的模式'},'en'),'本人的模式')
 assert.equal(standardModeDescription({...python,description:'本人说明'},'en'),'本人说明')
})

test('发布了名称的预设（含本人改名）原样显示；Teloa 固定标准预设沿用标准模式；未知 id 不查原型链',()=>{
 assert.equal(presetDisplayName({id:'ptc',name:'批量整理'},'en'),'批量整理')
 assert.equal(presetDisplayName({id:'cordis',name:'Creator mode'},'zh-Hans'),'Creator mode')
 assert.equal(presetDisplayName({id:'teloa-standard',name:'標準模式'},'en'),'Standard mode')
 assert.equal(presetDisplayName({id:'standard',name:'本人的研究配置'},'en'),'本人的研究配置')
 assert.equal(presetDisplayName({id:'constructor'},'zh-Hans'),'constructor')
 assert.equal(presetDisplayName({id:'research'},'en'),'research')
})
