import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {chmod,lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises'
import {dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {prepareNativeRuntime,installNativeRuntime} from './native-runtime.mjs'

/** 官方 profile 算法与公共受管组合统一复用；启动与 dump-config 都核验同一完整树。 */
export async function prepareManagedNativeProfile(layout){
 await mkdir(layout.runtimeRoot,{recursive:true,mode:0o700})
 const runtimeRoot=await realpath(layout.runtimeRoot),programRoot=await realpath(layout.programRoot),parent=relative(runtimeRoot,programRoot)
 if(parent===''||!isAbsolute(parent)&&parent.split(/[\\/]/)[0]!=='..')throw Error('原生运行副本目录不能是程序目录或其上级。')
 await chmod(runtimeRoot,0o700)
 const plan=await prepareNativeRuntime({programRoot,runtimeRoot})
 installNativeRuntime(plan) // 在任何 DSH/提供方导入前固定同一物理执行图。
 const require=createRequire(join(layout.programRoot,'package.json')),installAnchor=require.resolve('@deepseek-ai/dsh/package.json'),official=createRequire(installAnchor)
 const sdk=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-app-boot')).href),include=await import(pathToFileURL(official.resolve('@deepseek-ai/cordis-plugin-include')).href)
 const composition=await import(pathToFileURL(createRequire(join(layout.programRoot,'packages/harness-dsh/package.json')).resolve('@teloa/harness-dsh/native-input-composition')).href)
 if(composition.nativeInputCompositionVersion!==1)throw Error('公共核心的原生输入组合版本不正确。')
 const providers=await composition.loadNativeInputProviders({compatibilityAPIs:plan.compatibilityAPIs,requireCheckpoint:true,requireGoal:true})
 const profile=sdk.loadProfileDirectory('dsh',join(layout.dshHome,'profiles',layout.profileName),installAnchor)
 const context={name:layout.profileName,dir:profile.dir,patchPath:profile.patchPath,installAnchor,startedBundles:profile.layers.map(layer=>layer.packageName),cwd:layout.workspaceRoot,home:layout.dshHome,overlays:[],telemetryDisabledEnv:process.env.DSH_TELEMETRY_DISABLED}
 const effective=overlays=>include.applyEntryPatches([],sdk.readProfilePatches('dsh',{...context,overlays},profile),()=>{throw Error('公共原生输入组合不能完整解析。')})
 const inputProvider=await prepareNativeInputCarrier(runtimeRoot,programRoot)
 const overlays=await composition.composeNativeInput(effective([]),{providers,runtimeRoot,inputProvider,resolve:specifier=>official.resolve(specifier)})
 composition.assertNativeInputClientFaces(effective(overlays),{resolve:specifier=>official.resolve(specifier)})
 const bytes=JSON.stringify(overlays,null,2)+'\n',patchFile=join(runtimeRoot,'native-runtime-'+createHash('sha256').update(bytes).digest('hex')+'.patch.json')
 try{await writeFile(patchFile,bytes,{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}
 const saved=await lstat(patchFile);if(!saved.isFile()||saved.isSymbolicLink()||saved.nlink!==1||saved.mode&0o077||!Buffer.from(bytes).equals(await readFile(patchFile)))throw Error('公共原生组合覆盖已变化，保留现场并拒绝启动。')
 return Object.freeze({plan,profile,installAnchor,providers,composition,sdk,patchFile})
}

/** 官方目录清单按入口最近的 manifest 识别包；源码根没有版本，载体身份取实际公共 harness。 */
async function prepareNativeInputCarrier(runtimeRoot,programRoot){
 const source=new URL('./native-runtime-input.mjs',import.meta.url),manifest=JSON.parse(await readFile(join(programRoot,'packages/harness-dsh/package.json'),'utf8'))
 if(manifest.name!=='@teloa/harness-dsh'||typeof manifest.version!=='string'||!manifest.version)throw Error('公共输入提供方没有可信包身份。')
 const identity=JSON.stringify({name:manifest.name,version:manifest.version,type:'module'})+'\n',entry=`export {default,createManagedNativeRestore} from ${JSON.stringify(source.href)};\n`
 const base=join(runtimeRoot,'native-input-carriers');await mkdir(base,{recursive:true,mode:0o700})
 const parent=await lstat(base);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077||await realpath(base)!==base)throw Error('公共输入载体父目录不可信。')
 const directory=join(base,createHash('sha256').update(identity).update(entry).update(await readFile(source)).digest('hex'))
 await mkdir(directory,{recursive:true,mode:0o700})
 const state=await lstat(directory);if(!state.isDirectory()||state.isSymbolicLink()||state.mode&0o077)throw Error('公共输入载体目录不可信。')
 for(const [name,bytes] of [['package.json',identity],['native-runtime-input.mjs',entry]]){
  const path=join(directory,name);try{await writeFile(path,bytes,{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}
  const saved=await lstat(path);if(!saved.isFile()||saved.isSymbolicLink()||saved.nlink!==1||saved.mode&0o077||await readFile(path,'utf8')!==bytes)throw Error('公共输入载体已变化，拒绝启动。')
 }
 return join(directory,'native-runtime-input.mjs')
}

export async function runManagedNativeProfile(layout,args){
 const prepared=await prepareManagedNativeProfile(layout),official=createRequire(prepared.installAnchor)
 const {runProfile}=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh/profile-boot')).href)
 const running=await runProfile({environment:prepared.sdk.loadLayeredEnv('dsh'),profile:layout.profileName,resolvedProfile:{profile:prepared.profile,installAnchor:prepared.installAnchor},patchFiles:[prepared.patchFile],args})
 try{await waitManagedNativeServices(running.ctx,{requireGoal:!!prepared.providers.goal});prepared.composition.assertNativeInputProviders(running.ctx,prepared.providers,{resolve:specifier=>official.resolve(specifier)})}
 catch(error){await running.shutdown.shutdown(1);throw error}
 return running
}

/** 官方 boot 返回时异步业务插件仍可能在初始化；先等固定服务，随后严格核对其实际身份。 */
export async function waitManagedNativeServices(ctx,{requireGoal=false,timeoutMs=90000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>90000)throw Error('公共原生装配等待参数不正确。')
 const services=['teloaWork','teloaResidentInputAdmission',...(requireGoal?['teloaTaskRunGoal','teloaManagedGoalRoundDriver']:[])],deadline=Date.now()+timeoutMs
 while(services.some(name=>ctx.get(name)===undefined)){
  const remaining=deadline-Date.now();if(remaining<=0)throw Error('公共原生业务装配等待超时。')
  await new Promise(done=>setTimeout(done,Math.min(100,remaining)))
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const programRoot=resolve(process.env.TELOA_PROJECT_ROOT??join(dirname(fileURLToPath(import.meta.url)),'../..')),runtimeRoot=resolve(process.env.TELOA_RUNTIME_ROOT??join(programRoot,'.runtime/teloa')),dshHome=resolve(process.env.DSH_HOME??join(programRoot,'.runtime/dsh'))
  const raw=process.argv.slice(2),profileIndex=raw.indexOf('--profile'),profileName=profileIndex>=0?raw[profileIndex+1]:process.env.TELOA_DSH_PROFILE??'teloa'
  if(!profileName||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profileName)||profileIndex>=0&&raw.lastIndexOf('--profile')!==profileIndex)throw Error('原生运行 profile 名称无效。')
  const args=profileIndex>=0?raw.filter((_arg,index)=>index!==profileIndex&&index!==profileIndex+1):raw
  const layout={programRoot,runtimeRoot,dshHome,profileName,workspaceRoot:resolve(process.env.TELOA_WORKSPACE_ROOT??join(runtimeRoot,'workspace'))}
  const checks=args.filter(arg=>['--help','--version','--dump-config','--dump-default-config'].includes(arg))
  if(checks.length){
   if(checks.length!==1||args.length!==1)throw Error('原生运行检查参数不能混用。')
   const require=createRequire(join(programRoot,'package.json')),bin=join(dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js')
   const managed=checks[0]==='--dump-config'?await prepareManagedNativeProfile(layout):null
   process.argv=[process.execPath,bin,'--profile',profileName,...managed?['--patch',managed.patchFile]:[],...checks]
   await import(pathToFileURL(bin).href)
  }else await runManagedNativeProfile(layout,args)
 }catch(error){console.error(error instanceof Error?error.message:'原生运行准备失败。');process.exitCode=1}
}
