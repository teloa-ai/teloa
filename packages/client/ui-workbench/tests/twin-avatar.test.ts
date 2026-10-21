import {jsxAttributeExpressions} from './jsx-source-attributes.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import * as React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'

const client=new URL('../src/client/',import.meta.url),source=(name:string)=>readFileSync(new URL(name,client),'utf8')
const requireFromPackage=createRequire(new URL('../package.json',import.meta.url))

/** 真实组件函数 + 服务端渲染；CSS 模块按类名原样返回，其余依赖用包内真实模块。 */
function loadTwinAvatar(){
 const code=ts.transpileModule(source('TwinAvatar.tsx'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText
 const require=(id:string):unknown=>id.endsWith('.module.css')?{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})}:id==='react'?React:requireFromPackage(id)
 const exported:Record<string,any>={};new Function('require','exports','React',code)(require,exported,React)
 return exported.TwinAvatar as (props:Record<string,unknown>)=>React.ReactElement
}

test('分身头像：姓名缩写在固定尺寸容器内居中，Fingerprint 只作为角标；无缩写时人像居中而不是被当成角标',()=>{
 const TwinAvatar=loadTwinAvatar(),render=(props:Record<string,unknown>)=>renderToStaticMarkup(React.createElement(TwinAvatar,props))
 const named=render({initials:'ML'})
 assert.match(named,/^<span class="twin" aria-hidden="true" data-teloa-twin-avatar="">/)
 assert.match(named,/<span class="initials">ML<\/span>/,'缩写单独成居中文字层')
 assert.match(named,/<svg[^>]*class="[^"]*\bbadge\b[^"]*"/,'Fingerprint 带角标类')
 assert.equal((named.match(/<svg/g)??[]).length,1)
 const small=render({initials:'ML',size:'sm'})
 assert.match(small,/^<span class="twin sm" aria-hidden="true" data-teloa-twin-avatar="">/,'小号头像只加 sm 尺寸类')
 assert.match(small,/width="9" height="9"[^>]*class="[^"]*\bbadge\b/,'小号角标按比例缩小')
 const fallback=render({initials:''})
 assert.equal((fallback.match(/<svg/g)??[]).length,2,'无缩写：通用人像 + 角标')
 assert.equal((fallback.match(/\bbadge\b/g)??[]).length,1,'通用人像不能套角标定位')
})

test('分身头像样式：尺寸稳定、缩写居中、角标可溢出不被裁切',()=>{
 const css=source('TwinAvatar.module.css')
 const twin=/\.twin\{([^}]*)\}/.exec(css)?.[1]??''
 for(const rule of ['position:relative','display:inline-flex','align-items:center','justify-content:center','width:34px','height:34px','flex:0 0 34px'])assert.ok(twin.includes(rule),'.twin 缺少 '+rule)
 assert.ok(!/overflow:hidden/.test(twin),'分身头像本体不能裁切角标')
 assert.match(css,/\.badge\{[^}]*position:absolute/)
})

test('会话头部：分身走统一组件；撑满规则只作用于员工形象，分身容器不裁切角标',()=>{
 const frame=source('WorkbenchFrame.tsx'),header=source('EmployeeConversationHeader.module.css')
 assert.match(frame,/contextRole\.kind==='twin'\?<TwinAvatar initials=\{profile\.initials\}\/>/,'会话头部分身应使用 TwinAvatar 与本人缩写')
 assert.ok(!/\.avatar>img,\.avatar>span\{/.test(header),'头部不能无差别把所有子 span 撑满')
 assert.match(header,/\.avatar>span:not\(\[data-teloa-twin-avatar\]\)/)
 assert.match(header,/\.avatar:has\(>\[data-teloa-twin-avatar\]\)\{[^}]*overflow:visible/)
})

test('名单、个人页、群成员的分身都复用同一组件',()=>{
 for(const file of ['TwinProfile.tsx','StaffRoster.tsx','GroupMembersPanel.tsx'])assert.match(source(file),/<TwinAvatar initials=/,file+' 未复用 TwinAvatar')
 assert.ok(!source('TwinProfile.tsx').includes('<TwinAvatar initials={profileInitials} className='),'个人页不传不存在的样式类')
 assert.match(source('TwinAvatar.module.css'),/\.sm\{[^}]*width:22px;height:22px/)
})

test('群消息、话题预览、群进度、群概览成员与加成员选择器的分身都用本人缩写与统一组件',()=>{
 const page=source('SavedCollaborationPage.tsx')
 assert.match(page,/const twinInitials=personalAvatarInitials\(profileName\)/,'缩写只从本人姓名取')
 assert.match(page,/kind==='twin'\?<TwinAvatar initials=\{twinInitials\} size="sm"\/>:roleAvatars\[person\.roleId\]\?<EmployeeAvatar/,'群进度')
 assert.match(page,/kind==='twin'\?<TwinAvatar initials=\{twinInitials\} size="sm"\/>:'runId' in message\?<EmployeeAvatar/,'话题预览')
 assert.match(page,/const avatar=identity\.kind==='twin'\?<TwinAvatar initials=\{twinInitials\}\/>/,'群消息')
 assert.match(page,/role\?\.kind==='twin'\?<TwinAvatar initials=\{personalAvatarInitials\(props\.profileName\)\}\/>/,'群概览成员')
 assert.match(page,/role\.kind==='employee'\?<EmployeeAvatar avatarKey=\{role\.avatarKey\} size="md"\/>:<TwinAvatar initials=\{personalAvatarInitials\(profileName\)\}\/>/,'加成员选择器')
 assert.deepEqual(jsxAttributeExpressions(page,'SavedMessage','twinInitials'),['twinInitials','twinInitials'],'主会话与话题都透传 twinInitials')
 assert.match(page,/<GroupReplyPreview [^>]*twinInitials=\{twinInitials\}/)
 assert.ok(!/kind!=='twin'/.test(page),'不再把分身落入名称首字回退')
})
