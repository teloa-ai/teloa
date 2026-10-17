import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {spawnSync} from 'node:child_process'

// 新 revision 从固定官方原包与已审 work-admission 生成；旧补丁和安装目录保持只读。
const require=createRequire(new URL('../packages/harness-dsh/package.json',import.meta.url))
const source=dirname(require.resolve('@deepseek-ai/dsh-tools/package.json'))
const compat=new URL('../packages/harness-dsh/compat/',import.meta.url)
const previous='dsh-tools-0.2.1-rc.2-work-admission',revision='dsh-tools-0.2.1-rc.2-scoped-ptc'
const hash=value=>createHash('sha256').update(value).digest('hex')
const baseline=JSON.parse(await readFile(new URL(previous+'.json',compat),'utf8'))
const patch=await readFile(new URL(previous+'.patch',compat))
assert.equal(hash(patch),baseline.patchSha256)
const temporary=await mkdtemp(join(tmpdir(),'teloa-scoped-ptc-source-'))
try{
 const before=new Map()
 for(const file of baseline.files){
  const bytes=await readFile(join(source,file.path));assert.equal(hash(bytes),file.beforeSha256)
  before.set(file.path,bytes);await mkdir(dirname(join(temporary,file.path)),{recursive:true});await writeFile(join(temporary,file.path),bytes)
 }
 const applied=spawnSync('patch',['--batch','--fuzz=0','-p1'],{cwd:temporary,input:patch,encoding:'utf8'})
 assert.equal(applied.status,0,applied.stdout+applied.stderr)
 const change=(body,from,to)=>{assert.equal(body.split(from).length,2,'固定源锚点变化：'+from.slice(0,80));return body.replace(from,to)}
 let js=await readFile(join(temporary,'lib/index.js'),'utf8')
 js=change(js,'\tmode;\n\tconstructor(scope)', '\tmode;\n\tptcRuntime;\n\tconstructor(scope)')
 js=change(js,'this.mode === void 0;', 'this.mode === void 0 && this.ptcRuntime === void 0;')
 js=change(js,'\tptcTransport;','\tptcTransports = new WeakMap();')
 js=change(js,'this.requirePtcRuntime(mode);\n\t\t\t\tconst render', 'this.requirePtcRuntime(mode, context.scope);\n\t\t\t\tconst render')
 js=change(js,'\trequirePtcTransport() {\n\t\tthis.ptcTransport ??= createRunCodeTool(this, {', '\trequirePtcTransport(scope) {\n\t\tconst runtime = this.requirePtcRuntime(this.modeFor(scope), scope);\n\t\tlet provider = runtime;\n\t\twhile (provider[symbols.original] !== void 0) provider = provider[symbols.original];\n\t\tlet transport = this.ptcTransports.get(provider);\n\t\tif (transport !== void 0) return transport;\n\t\ttransport = createRunCodeTool(this, {')
 js=change(js,'requireRuntime: () => this.requirePtcRuntime(this.defaultMode),','requireRuntime: () => runtime,')
 js=change(js,'peekRuntime: () => this.ctx.get("ptcRuntime"),','peekRuntime: () => runtime,')
 js=change(js,'\t\treturn this.ptcTransport;','\t\tthis.ptcTransports.set(provider, transport);\n\t\treturn transport;')
 js=change(js,'\t\tthis.requirePtcRuntime(mode);\n\t\treturn {','\t\tthis.requirePtcRuntime(mode, scope);\n\t\treturn {')
 js=change(js,'\trequirePtcRuntime(mode) {\n\t\tconst runtime = this.ctx.get("ptcRuntime");',`\t/** Bind an official provider to this composition; nearest scope wins. */
\tusePtcRuntime(runtime) {
\t\tif (scopeOf(this.ctx) === void 0) throw new Error("tools.usePtcRuntime() requires a scoped context");
\t\tif (!runtime || typeof runtime.resolve !== "function" || typeof runtime.run !== "function" || !Object.hasOwn(SDK_RENDERERS, runtime.language)) throw new TypeError("unsupported PTC runtime");
\t\treturn this.layers.effect(this.ctx, (layer) => {
\t\t\tif (layer.ptcRuntime !== void 0) throw new Error("PTC runtime already selected for this scope");
\t\t\tlayer.ptcRuntime = runtime;
\t\t\treturn () => { layer.ptcRuntime = void 0; };
\t\t}, { label: "tools.usePtcRuntime()" });
\t}
\trequirePtcRuntime(mode, scope) {
\t\tconst layers = this.layers.chainLayers(scope);
\t\tconst runtime = layers.toReversed().find((layer) => layer.ptcRuntime !== void 0)?.ptcRuntime ?? this.ctx.get("ptcRuntime");`)
 js=change(js,'this.requirePtcTransport());','this.requirePtcTransport(scope));')
 // 每个 transport 绑定不可变 provider；SDK、schema/presentation 与 execute 由同一 scope 解析。
 js=change(js,'Assembly and `run_code` execution read separately, so the language is not\n\t* bound to a request. Harmless while one published backend exists — both\n\t* reads return the same flavor — but a reload that swapped in a second\n\t* language between them would hand a program written against one SDK to the\n\t* other. Binding it is deferred until a second backend ships (the first\n\t* point it is testable).','Scoped bindings select the provider for SDK assembly and transport lookup.\n\t* Each cached transport retains that exact provider for execution and\n\t* presentation; a different preset cannot reuse another language\'s transport.')
 let types=await readFile(join(temporary,'lib/types/index.d.ts'),'utf8')
 types=change(types,"import type { Agent } from '@deepseek-ai/dsh-agent';", "import type { Agent } from '@deepseek-ai/dsh-agent';\nimport type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime';")
 types=change(types,'    private ptcTransport;','    private ptcTransports;')
 types=change(types,'    private requirePtcRuntime;','    /** Bind an official provider to the current scoped composition. */\n    usePtcRuntime(runtime: PtcRuntime): () => void;\n    private requirePtcRuntime;')
 const outputs=new Map([['lib/index.js',js],['lib/types/index.d.ts',types]])
 let difference=''
 for(const [path,body] of outputs){
  const old=join(temporary,'before-'+path.replaceAll('/','-')),next=join(temporary,path)
  await writeFile(old,before.get(path));await writeFile(next,body)
  const diff=spawnSync('diff',['-u','--label','a/'+path,'--label','b/'+path,old,next],{encoding:'utf8'})
  assert.equal(diff.status,1,diff.stderr);difference+=diff.stdout
 }
 const manifest={...baseline,patchSha256:hash(difference),files:[...outputs].map(([path,body])=>({path,beforeSha256:hash(before.get(path)),afterSha256:hash(body)})),api:[...baseline.api,'ToolRuntime.usePtcRuntime'],scope:{...baseline.scope,ptc:'Nearest scoped binding selects an official runtime; SDK and runtime-specific cached run_code transport agree. Host default, scheduler, approvals, sandbox policy and stateOwner remain official.',supersedes:previous,applicationOrder:'Apply this cumulative revision once to the exact official npm input; do not stack with work-admission.'}}
 for(const [suffix,body] of [['patch',difference],['json',JSON.stringify(manifest,null,2)+'\n']]){
  const target=new URL(revision+'.'+suffix,compat)
  if(process.argv.includes('--check'))assert.equal(await readFile(target,'utf8'),body,'PTC 作用域适配已过期')
  else await writeFile(target,body)
 }
 console.log('PTC 作用域适配 '+(process.argv.includes('--check')?'核对通过':'已生成')+'：'+hash(difference))
}finally{await rm(temporary,{recursive:true,force:true})}
