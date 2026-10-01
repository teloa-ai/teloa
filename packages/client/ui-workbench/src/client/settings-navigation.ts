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
