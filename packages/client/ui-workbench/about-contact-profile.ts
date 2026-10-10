import {fileURLToPath} from 'node:url'

// 构建时选择依赖图，不能用运行时隐藏代替商业包中的内容删除。
export function aboutContactBuildProfile(profile:string='community'){
 if(!['community','official'].includes(profile))throw Error('联系构建必须为 community 或 official。')
 const alias:Record<string,string>=profile==='community'?{'./AboutContacts.js':fileURLToPath(new URL('./src/client/CommunityAboutContacts.tsx',import.meta.url))}:{}
 return {profile,alias}
}
