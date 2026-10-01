import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

test('390px 会话标题把次要操作换到第二行并保留完整标题宽度',async()=>{
 const css=await readFile(new URL('../src/client/WorkbenchFrame.module.css',import.meta.url),'utf8')
 assert.match(css,/@media\(max-width:740px\)\{[\s\S]*\[data-slot="conversation\.session\.header"\][\s\S]*flex-wrap:wrap/)
 assert.match(css,/\[data-slot="conversation\.session\.header\.utilities"\][\s\S]*flex:1 1 100%/)
 assert.doesNotMatch(css,/wSkVaW_|_[A-Za-z0-9]{5,}_/,'不得依赖 DSH 构建生成的类名')
})
