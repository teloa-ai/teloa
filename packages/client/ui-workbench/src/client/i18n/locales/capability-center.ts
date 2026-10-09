const rows=[
 ['title','能力中心','能力中心','Capability center'],
 ['description','管理已有能力，发现能帮你完成工作的技能和连接器。','管理現有能力，探索能協助你完成工作的技能與連接器。','Manage your capabilities and discover skills and connectors for your work.'],
 ['mode','浏览与管理','瀏覽與管理','Browse and manage'],
 ['mine','我的','我的','Mine'],
 ['discover','发现','探索','Discover'],
 ['installations','管理安装','管理安裝','Manage installations'],
 ['settings','连接与运行环境','連線與執行環境','Connections and environment'],
 ['connectors','连接器','連接器','Connectors'],
 ['searchDiscover','搜索技能、连接器和方案','搜尋技能、連接器及方案','Search skills, connectors and solutions'],
 ['search','搜索我的能力','搜尋我的能力','Search my capabilities'],
 ['noMatch','没有找到匹配的能力','找不到符合條件的能力','No matching capabilities'],
 ['clear','清空搜索','清除搜尋','Clear search'],
 ['closeDetail','关闭详情','關閉詳情','Close details'],
 ['tools','已发现 {count} 项工具','已探索到 {count} 項工具','{count} tools discovered'],
 ['all','全部','全部','All'],
] as const
export type CapabilityCenterMessageKey=`capabilityCenter.${typeof rows[number][0]}`
export const CAPABILITY_CENTER_MESSAGE_KEYS=rows.map(row=>`capabilityCenter.${row[0]}` as CapabilityCenterMessageKey)
const column=(i:1|2|3)=>Object.fromEntries(rows.map(row=>[`capabilityCenter.${row[0]}`,row[i]])) as Readonly<Record<CapabilityCenterMessageKey,string>>
export const capabilityCenterMessages={'zh-CN':column(1),'zh-Hant':column(2),en:column(3)}
export const capabilityCenterHongKongMessages={...column(2),'capabilityCenter.description':'管理現有能力，探索能幫你完成工作的技能及連接器。','capabilityCenter.settings':'連接與執行環境'}
