import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'

for(const name of ['ResourceManager.tsx','RoleKnowledge.tsx'])test(`${name} 固定界面文案全部来自词典`,async()=>{
  const source=await readFile(new URL(`../src/client/${name}`,import.meta.url),'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(name,source),[])
  if(name==='ResourceManager.tsx'){
    assert.doesNotMatch(source,/>Knowledge</)
    assert.doesNotMatch(source,/'knowledge\.generic'/)
    assert.match(source,/t\('knowledge\.manager\.title'\)/)
    assert.match(source,/t\('knowledge\.manager\.detailAria'\)/)
  }else{
    assert.doesNotMatch(source,/>Knowledge</)
    assert.doesNotMatch(source,/'knowledge\.generic'/)
    assert.match(source,/t\('knowledge\.rolePicker'\)/)
    assert.match(source,/t\('knowledge\.role\.notice'\)/)
  }
})
