import {readFileSync} from 'node:fs'
import ts from 'typescript'

/** 运行产品共用控件，夹具只替换样式；不复制或绕过按钮的真实命名与回调。 */
export function toolbarIconComponent(React:unknown){
 const exported:Record<string,any>={}
 const code=ts.transpileModule(readFileSync(new URL('../src/client/ToolbarIconButton.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const require=(id:string)=>{
  if(id==='react')return React
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id.endsWith('.module.css'))return {default:{button:'toolbarIconButton'}}
  throw Error('未声明的控件依赖：'+id)
 }
 new Function('require','exports','React',code)(require,exported,React)
 return exported.ToolbarIconButton
}
