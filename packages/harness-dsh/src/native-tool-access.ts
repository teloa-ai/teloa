import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ToolExecution} from '@deepseek-ai/dsh-tools'
import type {TaskToolArgumentRule} from './task-tool-arguments.ts'

const browserPrefix='mcp__playwright-mcp__'
const computerPrefix='cua_driver_native__'
/** 0.1.7-rc.1 官方 provider 的精确工具面；新增工具不会自动获得岗位授权资格。 */
export const nativeBrowserToolNames=[
 'browser_close','browser_resize','browser_console_messages','browser_handle_dialog','browser_evaluate',
 'browser_find','browser_fill_form','browser_press_key','browser_type','browser_navigate','browser_navigate_back',
 'browser_network_requests','browser_network_request','browser_take_screenshot','browser_snapshot','browser_click',
 'browser_drag','browser_hover','browser_select_option','browser_tabs','browser_wait_for',
].map(name=>browserPrefix+name)
export const nativeComputerToolNames=[
 'list_apps','list_windows','get_window_state','verify_state','click','double_click','right_click','drag',
 'type_text','press_key','hotkey','set_value','scroll','get_screen_size','get_desktop_state','get_cursor_position',
 'move_cursor','get_accessibility_tree','zoom',
].map(name=>computerPrefix+name)
export const nativeJobToolNames=['job_output','job_list','job_kill'] as const
export const nativeGrantToolNames:readonly string[]=[...nativeBrowserToolNames,...nativeComputerToolNames,...nativeJobToolNames]

/** 前缀仅识别需要拒绝未知工具的边界，不能据此前缀生成授权候选。 */
export function isNativeToolName(name:string):boolean{
 return name.startsWith(browserPrefix)||name.startsWith(computerPrefix)||(nativeJobToolNames as readonly string[]).includes(name)
}
export function nativeToolNeedsApproval(name:string):boolean{
 return nativeBrowserToolNames.includes(name)||nativeComputerToolNames.includes(name)
}
function providerName(ctx:Context,service:'browserUse'|'computerUse'):unknown{
 const registry:unknown=Reflect.get(ctx,service)
 return registry!==null&&typeof registry==='object'?Reflect.get(registry,'providerName'):undefined
}
function providerAvailable(ctx:Context,name:string):boolean{
 if(nativeBrowserToolNames.includes(name))return providerName(ctx,'browserUse')==='playwright-mcp'
 if(nativeComputerToolNames.includes(name))return providerName(ctx,'computerUse')==='cua-driver-native'
 return (nativeJobToolNames as readonly string[]).includes(name)&&Reflect.get(ctx,'jobs')!==undefined
}
/**
 * 只读官方已注册 schemas；不传 Agent 时合并宿主及现存 Agent，不为发现候选创建会话或启动浏览器。
 * Browser 工具属于原生 Agent scope；执行前仍须用调用方 Agent 重新核对，目录中的其他会话不能代授。
 */
export function nativeToolRules(ctx:Context,agent?:Agent):TaskToolArgumentRule[]{
 const scopes=agent?[agent]:[undefined,...ctx.agents.list()]
 const names=new Set(scopes.flatMap(scope=>ctx.tools.schemas(scope).map(tool=>tool.name)))
 return nativeGrantToolNames.filter(name=>names.has(name)&&providerAvailable(ctx,name))
  .map(name=>({name,anyArguments:true,allowed:[]}))
}
/** 工具本身的官方 sandbox 不约束桌面或浏览器；本次授权也不包含任意本机路径写出。 */
export function nativeToolCallIssue(ctx:Context,exec:ToolExecution):string|undefined{
 if(!nativeGrantToolNames.includes(exec.name)||!providerAvailable(ctx,exec.name)||!ctx.tools.get(exec.name,exec.agent))return '原生工具未启用、已断开或不在可授权范围内。'
 if(nativeToolNeedsApproval(exec.name)&&exec.arguments!==null&&typeof exec.arguments==='object'){
  const forbidden=exec.name.startsWith(browserPrefix)?['filename']:['screenshot_out_file','debug_image_out']
  if(forbidden.some(key=>Object.hasOwn(exec.arguments as object,key)))return '本次原生工具授权不包含写出本机文件，请移除文件路径参数。'
 }
}
