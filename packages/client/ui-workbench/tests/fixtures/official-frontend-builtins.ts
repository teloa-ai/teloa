import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import type {Plugin} from 'vite'

/** 发行端已打包的真实 UI builtins；不安装仅在上游开发时使用的 Markdown 依赖。 */
export function officialFrontendBuiltins(projectRoot:string):{plugin:Plugin;primitives:string}{
 const dsh=createRequire(createRequire(join(projectRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const frontend=createRequire(dsh.resolve('@deepseek-ai/dsh-web-app')).resolve('@deepseek-ai/dsh-web-frontend/package.json'),dist=join(dirname(frontend),'dist')
 const html=readFileSync(join(dist,'index.html'),'utf8'),asset=html.match(/src="\/?([^"\s]*assets\/index-[^"\s]+\.js)"/)
 if(!asset)throw Error('固定官方前端入口格式已变化。')
 const entry=join(dist,asset[1]!),source=readFileSync(entry,'utf8'),builtins=source.match(/function (\w+)\(\)\{return\{react:\w+,"react\/jsx-runtime":/),boot=source.search(/const \w+=globalThis\.dshDesktopBoot,/)
 if(!builtins||boot<0)throw Error('固定官方前端 builtins/boot 契约已变化。')
 const modules=new Map<string,string>(),primitives='\0teloa-official-primitives',react='\0teloa-official-react',jsx='\0teloa-official-jsx',dom='\0teloa-official-react-dom-client'
 const from=`import {builtins} from ${JSON.stringify(entry)};`
 modules.set(primitives,from+'export const {MarkdownText,MarkdownDelegateProvider}=builtins["@deepseek-ai/dsh-client-ui-primitives"];')
 modules.set(react,from+'const R=builtins.react;export default R.default??R;export const {Fragment,createElement,createContext,useContext,useMemo,useState,useRef,useEffect,useLayoutEffect,useSyncExternalStore,useReducer,useCallback,useId}=R;')
 modules.set(jsx,from+'export const {jsx,jsxs,Fragment}=builtins["react/jsx-runtime"];')
 modules.set(dom,from+'export const {createRoot,hydrateRoot}=builtins["react-dom/client"];')
 return {primitives,plugin:{name:'official-frontend-builtins',enforce:'pre',resolveId:id=>id==='react'?react:id==='react/jsx-runtime'?jsx:id==='react-dom/client'?dom:modules.has(id)?id:null,load:id=>id===entry?source.slice(0,boot)+'\nexport const builtins='+builtins[1]+'();':modules.get(id)??null}}
}
