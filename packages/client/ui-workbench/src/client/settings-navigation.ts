/** 设置目录的唯一选中态，供页内切换与原生配置入口共用。 */
export function createSettingsNavigation(){
  let selected:string|undefined
  const listeners=new Set<()=>void>()
  return {
    getSnapshot:()=>selected,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
    select(id:string){
      if(selected===id)return
      selected=id
      for(const listener of [...listeners])listener()
    },
  }
}
export type SettingsNavigation=ReturnType<typeof createSettingsNavigation>

export const settingsGroupOrder=['preferences','models','connections','work','advanced','about'] as const
export type SettingsGroup=typeof settingsGroupOrder[number]
/** 分类只管理呈现，不接管插件配置；未知入口进入高级，保持可达。 */
export function settingsEntryGroup(id:string):SettingsGroup{
 if(id==='general')return 'preferences'
 if(['models','teloa-local-models','teloa-credential-store','teloa-voice-service'].includes(id))return 'models'
 if(['teloa-workspaces','teloa-native-panels','teloa-im-channels','teloa-hardware-devices','teloa-employee-integrations'].includes(id))return 'connections'
 if(['teloa-auto-dream','agent-presets'].includes(id))return 'work'
 return id==='teloa-about'?'about':'advanced'
}
