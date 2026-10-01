import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const root=resolve(import.meta.dirname,'..')
const read=name=>readFileSync(resolve(root,name),'utf8')
// 只看构建上下文里的 COPY（--from 引用的是其他阶段）；最后一个参数是目标。
const sources=read('Dockerfile').split('\n').map(line=>line.trim()).filter(line=>/^COPY\s/i.test(line)&&!/--from=/i.test(line))
  .flatMap(line=>line.split(/\s+/).slice(1).filter(part=>!part.startsWith('--')).slice(0,-1))

test('Dockerfile 的 COPY 源路径都已纳入版本库',()=>{
  assert.ok(sources.length>0)
  // 本机被 .gitignore 挡住的旧文件也会让“存在”成立，因此以版本库为准，CI 干净检出才能复现。
  for(const source of sources){
    const tracked=execFileSync('git',['ls-files','--',source],{cwd:root,encoding:'utf8'}).trim()
    assert.ok(tracked,'Dockerfile 引用的路径不在版本库中：'+source)
  }
})

test('Dockerfile 的 COPY 源路径均被 .dockerignore 显式放行',()=>{
  const allowed=read('.dockerignore').split('\n').map(line=>line.trim()).filter(line=>line.startsWith('!')).map(line=>line.slice(1))
  for(const source of sources){
    const ok=allowed.some(rule=>rule===source||rule===source+'/'||(rule.endsWith('/**')&&(source===rule.slice(0,-3)||source.startsWith(rule.slice(0,-2)))))
    assert.ok(ok,'.dockerignore 未放行 Dockerfile 引用的路径：'+source)
  }
})

test('Docker 构建上下文带上 NOTICE 引用的根许可资料',()=>{
 const allowed=read('.dockerignore').split('\n').map(line=>line.trim()).filter(line=>line.startsWith('!')).map(line=>line.slice(1))
 for(const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','TRADEMARK.md','third-party-licenses']){
  assert.ok(sources.includes(name),'Dockerfile 未复制根许可资料：'+name)
  assert.ok(allowed.includes(name),'.dockerignore 未放行根许可资料：'+name)
 }
})
