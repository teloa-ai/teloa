import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('root 使用 rc.1 顶层 slot 并把原生会话交给 keyed main',async()=>{
  const [entry,frame]=await Promise.all([
    readFile(new URL('../src/client/index.ts',import.meta.url),'utf8'),
    readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
  ])
  for(const slot of ['sidebar','main','rightbar','shell.overlay'])assert.match(entry,new RegExp(`['"]?${slot.replace('.','\\.')}['"]?:\\{kind:`))
  assert.match(entry,/provideRoot\(\{hooks:\{panelInfo:/)
  assert.match(frame,/renderSlot\('main',\{\},\s*\{entryKey:/)
  assert.doesNotMatch(frame,/renderSlot\('conversation'/)
  assert.match(frame,/renderSlot\('rightbar',\{width:/)
  assert.match(entry,/ctx\.inject\(\[\.\.\.WORK_CONTEXT_INJECT\],child=>/)
})
