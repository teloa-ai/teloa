import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {runInNewContext} from 'node:vm'
import {execFileSync} from 'node:child_process'

test('客户端 CSS 和图片可实际加载，构建目录变化不泄露本机路径或改变样式身份',async t=>{
 const outputs:string[]=[]
 for(const prefix of ['private-builder-a-','private-builder-b-']){
  const root=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(root,{recursive:true,force:true}))
  const source=join(root,'src');await mkdir(source)
  await writeFile(join(source,'index.ts'),"import styles from './theme.module.css';import logo from './logo.svg';export {styles,logo}")
  await writeFile(join(source,'theme.module.css'),'.card{color:rgb(12,34,56)}')
  await writeFile(join(source,'logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>')
  // 与 pnpm 包构建相同：进程 cwd 就是包根；只设置 tsdown.cwd 不改变注释里的路径基准。
  const script='import {build} from '+JSON.stringify(import.meta.resolve('tsdown'))+';import {clientBundle} from '+JSON.stringify(new URL('../../tsdown.preset.ts',import.meta.url).href)+';await build({...clientBundle("@teloa/build-fixture","src/index.ts")[1],config:false,outDir:"lib",sourcemap:false,logLevel:"error"})'
  execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:root,stdio:'pipe'})
  const output=await readFile(join(root,'lib/client.js'),'utf8')
  assert.equal(output.includes(root),false,'产物不得携带构建机绝对目录')
  const styles:Array<{textContent:string}>=[];let exports:any
  runInNewContext(output,{window:{__ModuleLoader__:{load:({factory}:any)=>{exports=factory(()=>{throw Error('意外外部模块')})}}},document:{querySelector:()=>null,createElement:()=>({dataset:{}}),head:{appendChild:(style:any)=>styles.push(style)}}})
  assert.equal(styles.length,1);assert.ok(styles[0]!.textContent.includes('.'+exports.styles.card));assert.match(exports.logo,/^data:image\/svg\+xml;base64,/)
  outputs.push(output)
 }
 assert.equal(outputs[0],outputs[1],'相同输入的客户端运行字节不随构建目录变化')
})
