import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {githubSourcePreview} from '../src/client/github-source-preview.ts'
import type {GithubSourceReceipt} from '../src/client/github-source-api.ts'

const bytes=new TextEncoder().encode('说明'),receipt:GithubSourceReceipt={requestId:'11111111-1111-4111-8111-111111111111',ownerId:'self',stage:'ready',provenance:{kind:'github',owner:'teloa-ai',repo:'starter',requestedRef:'main',resolvedCommit:'0123456789abcdef0123456789abcdef01234567',archiveHash:'a'.repeat(64)},files:[{path:'README.md',hash:'b'.repeat(64),bytes}],createdAt:'2026-09-12T08:00:00.000Z',updatedAt:'2026-09-12T08:01:00.000Z'}

test('真实固定回执汇总提交、文件和行业清单发现结果',async()=>{
 const preview=await githubSourcePreview(receipt)
 assert.equal(preview.repository,'teloa-ai/starter');assert.equal(preview.commit,receipt.provenance.resolvedCommit);assert.equal(preview.totalBytes,bytes.byteLength);assert.equal(preview.files[0]?.path,'README.md');assert.deepEqual(preview.discovery,[])
})

test('GitHub 文件中的候选行业清单使用既有严格解析器发现',async()=>{
 const preview=githubSourcePreview(receipt,[{path:'teloa.json',error:'JSON 格式无效。'}])
 assert.equal(preview.discovery.length,1);assert.equal(preview.discovery[0]?.path,'teloa.json');assert.match(preview.discovery[0]!.error!,/JSON/)
})

test('客户端初始化并把真实 GitHub API 注入市场表单',async()=>{
 const [index,frame,page,forms]=await Promise.all([
  readFile(new URL('../src/client/index.ts',import.meta.url),'utf8'),readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8'),readFile(new URL('../src/client/MarketForms.tsx',import.meta.url),'utf8'),
 ])
 assert.match(index,/createGithubSourceApi/);assert.match(index,/teloa\.github-source\/v1/)
 assert.match(frame,/githubSourceApi/);assert.match(page,/githubSourceApi/)
 assert.match(forms,/githubSourceApi\.resolve/);assert.match(forms,/market\.forms\.check\.for\.incomplete\.acquisitions/);assert.doesNotMatch(forms,/mode==='github'\)item=sourceItem/)
})
