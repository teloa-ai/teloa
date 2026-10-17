import type {Context} from '@deepseek-ai/cordis'
import type {ToolRuntime} from '@deepseek-ai/dsh-tools'

export const name='teloa-ptc-selection'
export const inject=['tools','ptcRuntime']
/** 仅绑定组合内的官方 provider；解释器、worker、权限及生命周期仍由原生组件负责。 */
export function apply(ctx:Context):void{
 const tools=ctx.tools as ToolRuntime&{usePtcRuntime?:(runtime:unknown)=>()=>void}
 if(typeof tools.usePtcRuntime!=='function')throw Error('当前运行图尚未包含代码模式选择适配，请重新准备应用运行图。')
 tools.usePtcRuntime(Reflect.get(ctx,'ptcRuntime'))
}
