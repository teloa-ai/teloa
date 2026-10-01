import React from 'react'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
import {staffAvatarSeed} from '../src/client/staff-avatar-seed.ts'

// 群组件的轻量渲染器复用真实头像组件，不重复模拟形象逻辑。
const code=ts.transpileModule(readFileSync(new URL('../src/client/StaffAvatar.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
const exported:Record<string,unknown>={}
new Function('require','exports','React',code)((id:string)=>{
 if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
 if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
 if(id==='./staff-avatar-seed.ts')return {staffAvatarSeed}
 throw Error('未声明的头像依赖：'+id)
},exported,React)
export const staffAvatarComponent=exported
