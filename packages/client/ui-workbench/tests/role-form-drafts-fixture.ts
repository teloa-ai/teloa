import {readFileSync} from 'node:fs'
import ts from 'typescript'

/** 在同一手动 hooks 调度器中执行真实草稿模块，避免误用 React 的全局 dispatcher。 */
export function roleFormDraftModule(react:unknown){
 const code=ts.transpileModule(readFileSync(new URL('../src/client/role-form-drafts.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const exported:Record<string,unknown>={}
 new Function('require','exports',code)((id:string)=>{if(id==='react')return react;throw Error('未声明的草稿依赖：'+id)},exported)
 return exported
}
