import React from 'react'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
import {staffAvatarSeed} from '../src/client/staff-avatar-seed.ts'
import {createRequire} from 'node:module'
import {personalAvatarInitials} from '../src/client/personal-identity.ts'
import * as botAvatar from '../src/client/bot-avatar.ts'

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

const employeeCode=ts.transpileModule(readFileSync(new URL('../src/client/EmployeeAvatar.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
new Function('require','exports','React',employeeCode)((id:string)=>{
 if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
 if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
 if(id==='./bot-avatar.js')return botAvatar
 throw Error('未声明的员工头像依赖：'+id)
},exported,React)

// 分身头像同样复用真实组件；群组件按本人姓名取缩写，缩写函数用真实实现。
const twinCode=ts.transpileModule(readFileSync(new URL('../src/client/TwinAvatar.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
const packageRequire=createRequire(new URL('../package.json',import.meta.url))
new Function('require','exports','React',twinCode)((id:string)=>{
 if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
 if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
 if(id==='lucide-react')return packageRequire('lucide-react')
 throw Error('未声明的分身头像依赖：'+id)
},exported,React)
export const personalProfileForGroup={personalAvatarInitials}
