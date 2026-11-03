import {chmod,copyFile,lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {dirname,join,relative,resolve,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import ts from 'typescript'

// 发行范围固定；新增包必须明确选择运行资产，不能遍历整个仓库随意带出文件。
export const releasePackageDirectories=['contract','backend','mcp-reference','device-gateway','harness-dsh','realtime-voice','im-gateway','local-embedding','bundle','client/ui-kit','client/ui-workbench','cli','native-browser','native-computer','native-remote','sdk','xiaozhi-mcp']
const staticPackages=new Set(['native-browser','native-computer','native-remote','sdk'])
export const writeJson=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n')
export const json=async path=>JSON.parse(await readFile(path,'utf8'))
const safePath=path=>typeof path==='string'&&path.length>0&&!path.startsWith('/')&&!path.includes('\\')&&!path.split('/').some(part=>!part||part==='.'||part==='..')
const slash=path=>path.split(sep).join('/')
const omittedReleaseFile=name=>name.startsWith('._')||name==='.DS_Store'||/\.(?:map|tsbuildinfo)$/.test(name)
function compiledExports(value){
 if(typeof value==='string')return value.replace(/^\.\/src\//,'./lib/').replace(/(?<!\.d)\.ts$/,'.js')
 if(value===null)return null
 if(Array.isArray(value))return value.map(compiledExports)
 return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,compiledExports(entry)]))
}
function exportPaths(value){
 if(typeof value==='string')return [value]
 if(!value)return []
 return Object.values(value).flatMap(exportPaths)
}
/** 只复制普通文件；macOS 元数据、调试路径和链接不进入发行内容。 */
export async function copyReleaseFiles(source,target){
 const info=await lstat(source)
 if(info.isSymbolicLink())throw Error('发行输入包含符号链接：'+source)
 if(info.isDirectory()){
  await mkdir(target,{recursive:true})
  for(const entry of await readdir(source)){
   if(omittedReleaseFile(entry))continue
   await copyReleaseFiles(join(source,entry),join(target,entry))
  }
 }else if(info.isFile()){await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
 else throw Error('发行输入不是普通文件：'+source)
}
export async function releaseFiles(root){
 const rows=[]
 for(const entry of await readdir(root,{withFileTypes:true})){
  const path=join(root,entry.name)
  if(entry.isDirectory())rows.push(...await releaseFiles(path))
  else if(entry.isFile())rows.push(path)
  else throw Error('发行目录包含符号链接或特殊文件：'+path)
 }
 return rows.sort()
}
export async function validatePackageEntrypoints(root,manifest){
 const bins=typeof manifest.bin==='string'?[manifest.bin]:Object.values(manifest.bin??{})
 const patches=manifest.dsh?.bundle?.patch??[]
 for(const original of [...exportPaths(manifest.exports),...bins,...(Array.isArray(patches)?patches:[patches])]){
  const path=original.replace(/^\.\//,'')
  if(!safePath(path))throw Error('发行入口路径无效：'+original)
  let info
  try{info=await lstat(join(root,path))}catch{throw Error('发行入口不存在：'+original)}
  if(!info.isFile()||info.isSymbolicLink())throw Error('发行入口不是普通文件：'+original)
 }
 for(const bin of bins)await chmod(join(root,bin),0o755)
}
async function currentSourceFile(root,path){
 const local=slash(relative(resolve(root),resolve(path)))
 if(!safePath(local))return false
 let current=resolve(root),info
 for(const part of local.split('/')){
  current=join(current,part)
  try{info=await lstat(current)}catch(error){if(error.code==='ENOENT')return false;throw error}
  if(info.isSymbolicLink())throw Error('发行来源包含符号链接：'+local)
 }
 return info.isFile()
}
/** 只解释当前已采用的静态构建声明，不执行 tsdown 配置或任何构建脚本。 */
async function clientGeneratedOutputs(root,source,manifest,expected){
 const configPath=join(source,'tsdown.config.ts')
 if(!await currentSourceFile(root,configPath))return
 const config=ts.createSourceFile(configPath,await readFile(configPath,'utf8'),ts.ScriptTarget.Latest,true),helpers=new Map()
 if(config.parseDiagnostics.length)throw Error('客户端发行构建声明无法解析。')
 for(const statement of config.statements){
  if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)||statement.moduleSpecifier.text!=='../tsdown.preset.ts')continue
  const bindings=statement.importClause?.namedBindings
  if(bindings&&ts.isNamedImports(bindings))for(const item of bindings.elements)helpers.set(item.name.text,item.propertyName?.text??item.name.text)
 }
 const declarations=new Map(),defaults=[]
 for(const statement of config.statements){
  if(ts.isExportAssignment(statement)&&!statement.isExportEquals)defaults.push(statement.expression)
  if(ts.isVariableStatement(statement)&&(statement.declarationList.flags&ts.NodeFlags.Const))for(const item of statement.declarationList.declarations){
   if(ts.isIdentifier(item.name))declarations.set(item.name.text,declarations.has(item.name.text)?undefined:item.initializer)
  }
 }
 if(defaults.length!==1)throw Error('客户端发行默认导出无法确定。')
 const active=new Set(),memo=new Map()
 const readConfig=node=>{
  if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isNonNullExpression(node))return readConfig(node.expression)
  if(ts.isIdentifier(node)){
   const name=node.text
   if(active.has(name))throw Error('客户端发行默认导出存在循环声明：'+name)
   if(memo.has(name))return memo.get(name)
   const declaration=declarations.get(name)
   if(!declaration)throw Error('客户端发行默认导出无法确定声明：'+name)
   active.add(name);const result=readConfig(declaration);active.delete(name);memo.set(name,result);return result
  }
  if(ts.isArrayLiteralExpression(node)){
   const items=[]
   for(const element of node.elements){
    const spread=ts.isSpreadElement(element),value=readConfig(spread?element.expression:element)
    if(spread){if(value.kind!=='array')throw Error('客户端发行默认导出展开项不是静态数组。');items.push(...value.items)}
    else{if(value.kind!=='config')throw Error('客户端发行默认导出数组包含无法确定的配置。');items.push(value)}
   }
   return {kind:'array',items}
  }
  if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){
   const helper=helpers.get(node.expression.text)
   if(['clientBundle','clientChunk','standaloneClientBundle'].includes(helper)){
    if(node.arguments.some(argument=>!ts.isStringLiteral(argument)))throw Error('客户端发行构建入口必须使用可核对的静态字符串。')
    const args=node.arguments.map(argument=>argument.text),item=(outputs,sources)=>({kind:'config',outputs,sources})
    if(args[0]!==manifest.name)throw Error('客户端发行构建包身份不一致。')
    if(helper==='clientBundle'&&args.length===2)return {kind:'array',items:[item(['lib/index.js'],['src/index.ts']),item(['lib/client.js'],[args[1]])]}
    if(helper==='clientChunk'&&args.length===3&&/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test('client.'+args[1]+'.js'))return item(['lib/client.'+args[1]+'.js'],[args[2]])
    if(helper==='standaloneClientBundle'&&args.length===3)return item(['lib/guest.js'],args.slice(1))
    throw Error('客户端发行构建声明不受支持。')
   }
  }
  throw Error('客户端发行默认导出无法确定；只支持静态数组、展开、顶层 const 和已知构建 helper。')
 }
 const exported=readConfig(defaults[0]),recipes=exported.kind==='array'?exported.items:[exported]
 if(recipes.length&&!await currentSourceFile(root,join(source,'../tsdown.preset.ts')))throw Error('客户端发行构建预设不存在。')
 for(const recipe of recipes){
  for(const file of recipe.sources)if(!safePath(file)||!file.startsWith('src/')||!await currentSourceFile(root,join(source,file)))throw Error('客户端发行构建来源不存在：'+file)
  for(const file of recipe.outputs)expected.add(resolve(source,file))
 }
}
/** 拒绝被删源码遗留在 lib 的输出；仅核对来源，不编译、不清理用户构建目录。 */
export async function validateCompiledReleaseInputs({root,directory,manifest}){
 const source=resolve(root,'packages',directory),configPath=join(source,'tsconfig.json'),lib=join(source,'lib')
 if(!await currentSourceFile(root,configPath))throw Error('发行编译配置不存在：'+directory+'/tsconfig.json')
 const parsed=ts.getParsedCommandLineOfConfigFile(configPath,{}, {...ts.sys,onUnRecoverableConfigFileDiagnostic:diagnostic=>{throw Error('发行编译配置无效：'+ts.flattenDiagnosticMessageText(diagnostic.messageText,' '))}})
 if(!parsed||parsed.errors.length||parsed.options.noEmit||!parsed.options.rootDir||!parsed.options.outDir)throw Error('发行编译配置不能确定当前输出：'+directory)
 const expected=new Set()
 for(const file of parsed.fileNames){
  if(!await currentSourceFile(root,file))throw Error('发行编译来源不存在：'+slash(relative(source,file)))
  for(const output of ts.getOutputFileNames(parsed,file,!ts.sys.useCaseSensitiveFileNames))expected.add(resolve(output))
 }
 if(directory==='client/ui-workbench')await clientGeneratedOutputs(root,source,manifest,expected)
 const info=await lstat(lib)
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('发行 lib 不是普通目录：'+directory)
 const orphaned=[]
 for(const file of await releaseFiles(lib)){
  if(slash(relative(lib,file)).split('/').some(omittedReleaseFile)||expected.has(resolve(file)))continue
  // 原样复制的模块、声明及静态资产必须与当前同路径源码逐字节相同。
  const local=slash(relative(parsed.options.outDir,file)),original=safePath(local)?resolve(parsed.options.rootDir,local):undefined
  if(original&&await currentSourceFile(root,original)&&(await readFile(original)).equals(await readFile(file)))continue
  orphaned.push(slash(relative(source,file)))
 }
 if(orphaned.length)throw Error('发行编译文件无当前来源，已在复制前拒绝：'+directory+'\n'+orphaned.join('\n'))
}
export async function prepareReleasePackage({root,stage,directory,version,dependencies={}}){
 if(!releasePackageDirectories.includes(directory))throw Error('未声明的发行包：'+directory)
 const source=join(root,'packages',directory),target=join(stage,'packages',directory),original=await json(join(source,'package.json'))
 if(!staticPackages.has(directory)&&directory!=='bundle')await validateCompiledReleaseInputs({root,directory,manifest:original})
 const runtimeDependencies=Object.fromEntries(Object.entries(original.dependencies??{}).filter(([name])=>name.startsWith('@teloa/')||name in dependencies).map(([name,value])=>[name,name.startsWith('@teloa/')?version:value]))
 const exports=compiledExports(original.exports??{})
 const manifest={name:original.name,version,type:'module',description:original.description,engines:original.engines,bin:original.bin,exports:{...(typeof exports==='string'?{'.':exports}:exports),'./package.json':'./package.json'},dsh:original.dsh,...(Object.keys(runtimeDependencies).length?{dependencies:runtimeDependencies}:{})}
 await mkdir(target,{recursive:true})
 await writeJson(join(target,'package.json'),manifest)
 const copy=file=>copyReleaseFiles(join(source,file),join(target,file))
 if(staticPackages.has(directory)){
  for(const file of original.files??[]){if(!safePath(file))throw Error('发行 files 路径无效：'+file);await copy(file)}
 }else if(directory==='bundle'){
  await copy('cordis.patch.yml');await copy('agent-presets')
 }else{
  await copy('lib')
  if(directory==='harness-dsh'){
   const {nativeRuntimeCompatibilityFiles}=await import(pathToFileURL(join(root,'scripts/runtime/native-runtime.mjs')).href)
   for(const file of nativeRuntimeCompatibilityFiles)await copy('compat/'+file)
  }
  if(directory==='cli'){
   await copy('libexec/support.json')
   const support=await json(join(target,'libexec/support.json'))
   if(support.schema!=='teloa.maintenance-process-support/v1'||typeof support.supported!=='boolean')throw Error('维护 helper 支持清单无效')
   if(support.supported){
    await copy('libexec/maintenance-process')
    const binary=join(target,'libexec/maintenance-process')
    if(createHash('sha256').update(await readFile(binary)).digest('hex')!==support.binarySha256)throw Error('维护 helper 摘要不匹配')
    await chmod(binary,0o755)
   }
  }
  const assets={
   'mcp-reference':['materials'],
   'im-gateway':['cordis.patch.yml','THIRD_PARTY_NOTICES.md','licenses'],
   'realtime-voice':['cordis.patch.yml','LICENSE-MIT.upstream'],
   'local-embedding':['cordis.patch.yml','runtime/assets.json','runtime/onnxruntime.json','PROVENANCE.md','LICENSE-MODEL'],
   'xiaozhi-mcp':['cordis.patch.yml'],
  }
  for(const file of assets[directory]??[])await copy(file)
 }
 await validatePackageEntrypoints(target,manifest)
 return manifest
}
