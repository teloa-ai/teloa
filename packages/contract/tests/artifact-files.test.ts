import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isArtifactFile,artifactFilePath,artifactFileMaxBytes } from '../src/artifact-files.ts'
const body=Buffer.from('原文\r\n'),file={schema:'teloa.file-snapshot/v1',sessionId:'s1',id:'a'.repeat(64),path:'docs/说明.md',sha256:createHash('sha256').update(body).digest('hex'),bytes:body.length,capturedAt:'2026-09-11T07:00:00Z',contentBase64:body.toString('base64')}
test('文件快照必须包含固定来源、大小与内容版本，不能把路径或 URL 当作文件内容',()=>{
  assert.equal(isArtifactFile(file),true)
  for(const patch of [{bytes:1},{contentBase64:'blob:temporary'},{sha256:'latest'},{bytes:artifactFileMaxBytes+1},{path:'../.env'},{path:'.runtime/dsh/credentials'},{path:'https://example.com/x'},{capturedAt:'yesterday'}])assert.equal(isArtifactFile({...file,...patch}),false,JSON.stringify(patch))
  assert.equal(artifactFilePath('docs/含 空格.txt'),true)
  assert.equal(artifactFilePath('docs/../../.runtime/x'),false)
})
