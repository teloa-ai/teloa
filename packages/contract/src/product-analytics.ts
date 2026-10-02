/** 产品遥测只保留固定事件和枚举；不接收会话、账号、路径、模型名称或用户输入。 */
export const productEventNames=[
 'desktop_app_launch','auth_page_view','auth_page_click','api_key_save_click',
 'onboarding_page_view','onboarding_page_click','onboarding_popup_view','onboarding_popup_click',
 'desktop_upgrade_click','desktop_upgrade_download_result','desktop_upgrade_install_restart_click',
 'send_button_click','model_switch','thinking_level_switch','context_compression','branch_session_click',
 'sidebar_menu_click','plugin_toggle','plugin_add_button_click','plugin_install_click','install_plugin_result','confirm_uninstall_plugin',
] as const
export type ProductEventName=(typeof productEventNames)[number]
export type ProductAnalyticsEvent={eventName:ProductEventName;timestamp:number;attributes:Record<string,string|number|boolean>}

const enums:Record<string,readonly string[]>={
 button_name:['sign_in','api-key','next','back','skip','charge','later','continue','know','enter','setting','close'],
 page_name:['onboarding_welcome','onboarding_recharge','onboarding_use_case','onboarding_process'],
 popup_name:['skip_charge','skip_setting'],
 selected_content:['office','code','code_office','focus_result','key_detail','full_process'],
 run_mode:['plan','goal','default'],msg_type:['default','steer','queue'],
 trigger_type:['auto','manual'],click_position:['footer','sidebar'],menu_name:['plugin','cron'],plugin_type:['plugin','bundle'],
}
const booleans=['is_success','is_enabled','is_builtin']
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

/** 官方事件在进入 OTel 队列前裁掉所有未经批准的字段，body 由事件名生成。 */
export function sanitizeProductEvent(value:unknown):ProductAnalyticsEvent|undefined{
 if(!record(value)||typeof value.eventName!=='string'||!(productEventNames as readonly string[]).includes(value.eventName)
  ||typeof value.timestamp!=='number'||!Number.isSafeInteger(value.timestamp)||value.timestamp<0)return undefined
 const attributes:ProductAnalyticsEvent['attributes']={}
 if(record(value.attributes))for(const [key,item] of Object.entries(value.attributes)){
  if(typeof item==='string'&&Object.hasOwn(enums,key)&&enums[key]!.includes(item)||typeof item==='boolean'&&booleans.includes(key))attributes[key]=item as string|boolean
  else if(key==='duration'&&typeof item==='number'&&Number.isFinite(item)&&item>=0&&item<=600000)attributes[key]=item
 }
 return {eventName:value.eventName as ProductEventName,timestamp:value.timestamp,attributes}
}
