#!/usr/bin/env node
// 用法：node scripts/生成发行包.mjs <version> <新的 outDir> [已核验的依赖模板 tgz]
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,join,relative,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {copyReleaseFiles,json,prepareReleasePackage,releaseFiles,releasePackageDirectories,validatePackageEntrypoints,writeJson} from './release/package-files.mjs'
import {pinRuntimePnpm} from './release/runtime-pnpm.mjs'
import {pinRuntimeFastSha256} from './release/runtime-fast-sha256.mjs'

const [version,output='artifacts/release',templateInput]=process.argv.slice(2)
if(!/^\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(version??'')||version!==version?.trim())throw Error('需要稳定版或 RC 版本号，例如 0.2.11 或 0.2.11-rc.1')
const root=process.cwd(),outDir=resolve(output),stage=join(outDir,'package')
const baseline=await json(join(root,'config/dsh-baseline.json'))
const dshVersion=String(baseline.tag??'').replace(/^dsh-v/,'')
if(!dshVersion)throw Error('无法从 config/dsh-baseline.json 解析 DSH 版本')
// 目录必须是新的，防止旧产物或意外文件被再次发行。
await mkdir(outDir,{recursive:true})
await mkdir(stage)
// 暂沿用固定发行的依赖闭包，单次下载并核验完整性；文件路径从不进入 shell。
let templatePath=templateInput&&resolve(templateInput)
if(!templatePath){
 const metadataResponse=await fetch('https://registry.npmjs.org/@teloa%2fcli/0.2.8')
 if(!metadataResponse.ok)throw Error('无法读取固定依赖模板元数据。')
 const metadata=await metadataResponse.json()
 if(metadata.name!=='@teloa/cli'||metadata.version!=='0.2.8'||!/^sha512-/.test(metadata.dist?.integrity??''))throw Error('依赖模板身份无效。')
 const response=await fetch('https://registry.npmjs.org/@teloa/cli/-/cli-0.2.8.tgz')
 if(!response.ok)throw Error('无法读取固定依赖模板。')
 const bytes=Buffer.from(await response.arrayBuffer())
 if('sha512-'+createHash('sha512').update(bytes).digest('base64')!==metadata.dist.integrity)throw Error('依赖模板摘要不匹配。')
 templatePath=join(outDir,'dependency-template.tgz')
 await writeFile(templatePath,bytes,{flag:'wx'})
}
const templateJson=file=>JSON.parse(execFileSync('tar',['-xOzf',templatePath,'package/'+file],{encoding:'utf8',maxBuffer:16*1024*1024}))
const template=templateJson('package.json'),lock=templateJson('npm-shrinkwrap.json')
if(template.name!=='@teloa/cli'||lock.name!=='@teloa/cli'||!lock.packages?.[''])throw Error('依赖模板格式无效。')
const rootManifest={...template,name:'@teloa/cli',version}
pinRuntimePnpm(rootManifest,lock)
pinRuntimeFastSha256(rootManifest,lock,await json(join(root,'packages/contract/package.json')),await readFile(join(root,'pnpm-lock.yaml'),'utf8'))
const copy=(from,to=from)=>copyReleaseFiles(join(root,from),join(stage,to))
for(const file of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','TRADEMARK.md','README.md'])await copy(file)
await copy('third-party-licenses')
for(const file of ['dsh-baseline.json','dsh-package-versions.json'])await copy('config/'+file)
for(const file of ['scripts/runtime','scripts/核对DSH依赖.mjs','scripts/核对宿主就绪.mjs'])await copy(file)
await mkdir(join(stage,'bin'),{recursive:true})
await writeFile(join(stage,'bin/teloa.js'),"#!/usr/bin/env node\nimport {main} from '../packages/cli/lib/bin.js'\nimport {redactLog} from '../packages/cli/lib/diagnostics.js'\nmain().catch(error=>{console.error(redactLog(error.message));process.exitCode=error.exitCode??1})\n")
for(const directory of releasePackageDirectories)await prepareReleasePackage({root,stage,directory,version,dependencies:rootManifest.dependencies})
// npm 运行时使用本安装的服务状态与网关；源码 profile 保持不变。
const patchPath=join(stage,'packages/bundle/cordis.patch.yml')
await writeFile(patchPath,(await readFile(patchPath,'utf8')).replace('/packages/mcp-reference/src/main.ts','/packages/mcp-reference/lib/main.js')+[
 '',
 '- id: webserver','  disabled: true','- id: typert-gateway','  disabled: true','- insert:',
 '    - id: teloa-native-webserver',"      name: '@teloa/cli/webserver'",'      inject: [webStartup]','      config:',
 "        host: !!js ctx.webStartup.host ?? '127.0.0.1'",'        port: !!js ctx.webStartup.port ?? 3080',
 '        compression: gzip','        compressionLevel: 1','        compressionThresholdBytes: 1024',
 '    - id: teloa-native-gateway',"      name: '@teloa/native-gateway'",
 '    - id: teloa-install-runtime',"      name: '@teloa/cli/runtime'",'',
].join('\n'))
const bundlePath=join(stage,'packages/bundle/package.json'),bundle=await json(bundlePath)
bundle.dependencies={...bundle.dependencies,'@teloa/cli':version,'@teloa/native-gateway':version}
await writeJson(bundlePath,bundle)
const host=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
const gatewayRoot=dirname(createRequire(host.resolve('@deepseek-ai/dsh-base/package.json')).resolve('@deepseek-ai/dsh-api-gateway/package.json'))
const gateway=await json(join(gatewayRoot,'package.json')),entry=gateway.exports?.['./client']
const clientPath=typeof entry==='string'?entry:entry?.browser??entry?.default
if(typeof clientPath!=='string'||!/^\.\/lib\/[\w./-]+\.js$/.test(clientPath)||clientPath.split('/').slice(1).some(part=>!part||part==='.'||part==='..'))throw Error('无法核对官方网关浏览器入口。')
const client=await readFile(join(gatewayRoot,clientPath),'utf8')
if(!client.startsWith('window.__ModuleLoader__.load({')||!client.includes('id: "@deepseek-ai/dsh-api-gateway",'))throw Error('官方网关客户端格式已变化。')
const adapter=join(stage,'packages/native-gateway')
await mkdir(join(adapter,'lib'),{recursive:true})
const adapterManifest={name:'@teloa/native-gateway',version,type:'module',exports:{'.':'./lib/index.js','./client':'./lib/client.js','./package.json':'./package.json'},dsh:gateway.dsh,dependencies:{'@teloa/cli':version,'@deepseek-ai/dsh-api-gateway':gateway.version}}
await writeJson(join(adapter,'package.json'),adapterManifest)
await writeFile(join(adapter,'lib/index.js'),"export {default} from '@teloa/cli/gateway'\n")
await writeFile(join(adapter,'lib/client.js'),client+'\nwindow.__ModuleLoader__.load({id:"@teloa/native-gateway",factory:require=>require("@deepseek-ai/dsh-api-gateway")});\n')
await validatePackageEntrypoints(adapter,adapterManifest)
lock.version=version;lock.packages[''].version=version
await writeJson(join(stage,'package.json'),rootManifest)
await writeJson(join(stage,'npm-shrinkwrap.json'),lock)
await writeJson(join(stage,'config/npm-runtime-lock.json'),lock)
await validatePackageEntrypoints(stage,rootManifest)
const data=await json(join(root,'packages/cli/src/data-version.json'))
if(data.schema!=='teloa.data-version/v1'||!Number.isSafeInteger(data.dataVersion)||data.dataVersion<1||JSON.stringify(data.compatibleDataVersions)!==JSON.stringify([data.dataVersion]))throw Error('数据版本元数据无效。')
const files=[]
for(const full of await releaseFiles(stage)){
 const path=relative(stage,full).split('\\').join('/')
 if(path==='release-manifest.json'||path==='npm-shrinkwrap.json')continue
 files.push({path,sha256:createHash('sha256').update(await readFile(full)).digest('hex')})
}
files.sort((a,b)=>a.path.localeCompare(b.path))
await writeJson(join(stage,'release-manifest.json'),{contactProfile:'community',schema:'teloa.release/v1',version,dshVersion,dataVersion:data.dataVersion,compatibleDataVersions:data.compatibleDataVersions,files})
// npm pack 保持 npm/GitHub 共用同一工件，不让系统 tar 注入 AppleDouble 元数据。
const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',outDir],{cwd:stage,encoding:'utf8',maxBuffer:16*1024*1024}))
const tgz=join(outDir,packed[0].filename)
console.log(JSON.stringify({tgz,files:files.length+2,dshVersion,version}))
