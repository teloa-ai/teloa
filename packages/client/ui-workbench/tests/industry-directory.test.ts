import test from 'node:test'
import assert from 'node:assert/strict'
import { readIndustryDirectory } from '../src/client/industry-directory.ts'
const manifest={format:'teloa.business-package/v2',id:'research',title:'通用研究',version:'1.0.0',domain:'general',description:'研究资料',resources:[{id:'guide',kind:'knowledge',title:'研究手册',version:'1.0.0',required:true,source:{kind:'local',path:'knowledge/guide.md'}}],relations:[],entrypoints:[]}
const file=(path:string,text:string)=>{const bytes=new TextEncoder().encode(text);return {path,size:bytes.length,read:async()=>bytes}}
test('真实读取完整目录字节，固定摘要；同清单不同正文不合并',async()=>{
 const files=[file('teloa.json',JSON.stringify(manifest)),file('knowledge/guide.md','# 手册\n核对来源')]
 const first=await readIndustryDirectory(files,'teloa.json','研究模板')
 assert.equal(first.packageContent?.resources[0]?.state,'available')
 assert.equal(first.packageContent?.files.length,2)
 const changed=await readIndustryDirectory([files[0]!,file('knowledge/guide.md','新版正文')],'teloa.json','研究模板')
 assert.equal(first.hash,changed.hash)
 assert.notEqual(first.id,changed.id)
 assert.notEqual(first.packageContent?.hash,changed.packageContent?.hash)
 const reordered=await readIndustryDirectory([...files].reverse(),'teloa.json','研究模板')
 assert.equal(first.id,reordered.id)
})
test('缺文件与公共引用分别呈现，不冒充已读取或已安装',async()=>{
 const raw={...manifest,resources:[...manifest.resources,{id:'public',kind:'skill',title:'公共方法',version:'1.0.0',required:true,source:{kind:'public',id:'method',version:'1.0.0'}}]}
 const item=await readIndustryDirectory([file('teloa.json',JSON.stringify(raw))],'teloa.json','未完整模板')
 assert.deepEqual(item.packageContent?.resources.map(row=>row.state),['missing','unresolved'])
 assert.match(item.compatibility,/未加载/)
})
test('拒绝越界、重复、大小不符、超限和读取失败，不返回部分成功',async()=>{
 for(const path of ['../x','/x','a\\b','a//b','a/%2e/x'])await assert.rejects(()=>readIndustryDirectory([file(path,'x')],'teloa.json','x'),/路径/)
 await assert.rejects(()=>readIndustryDirectory([file('a','x'),file('a','y')],'a','x'),/重复/)
 await assert.rejects(()=>readIndustryDirectory([{...file('teloa.json','x'),size:99}],'teloa.json','x'),/大小/)
 await assert.rejects(()=>readIndustryDirectory([{path:'big',size:3*1024*1024,read:async()=>{throw Error('不应读取')}}],'big','x'),/超出/)
 await assert.rejects(()=>readIndustryDirectory([{path:'teloa.json',size:1,read:async()=>{throw Error('磁盘读取失败')}}],'teloa.json','x'),/读取失败/)
})
