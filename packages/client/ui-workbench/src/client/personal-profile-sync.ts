import {readPersonalDisplayProfile,type PersonalDisplayProfile} from '@teloa/contract'

/** 旧浏览器资料首次填入原宿主；后续以宿主资料为准，旧标签不能覆盖新姓名。 */
export function createPersonalProfileSync(call:(endpoint:string,payload:unknown)=>Promise<unknown>,local:{read:()=>PersonalDisplayProfile;write:(profile:PersonalDisplayProfile)=>void}){
 let pending:Promise<void>|undefined,writing:Promise<void>|undefined,disposed=false,revision=0
 const publish=(profile:PersonalDisplayProfile)=>{if(disposed)throw Error('个人资料连接已变化，请重试。');local.write(profile)}
 const ready=():Promise<void>=>{
  if(writing)return writing
  if(pending)return pending
  const captured=revision
  const next=(async()=>{
   let profile=readPersonalDisplayProfile(await call('profile/get',{}))
   const previous=local.read()
   if(!profile.displayName&&previous.displayName)profile=readPersonalDisplayProfile(await call('profile/initialize',{displayName:previous.displayName}))
   if(captured===revision)publish(profile)
  })()
  pending=next
  void next.finally(()=>{if(pending===next)pending=undefined}).catch(()=>{})
  return next
 }
 return {ready,async save(displayName:string){
  try{await ready()}catch(error){
   if(!error||typeof error!=='object'||!('code' in error)||error.code!=='teloa/storage-corrupt')throw error
  }
  if(writing)await writing
  revision++
  const next=Promise.resolve().then(async()=>{
   const profile=readPersonalDisplayProfile(await call('profile/save',{displayName}))
   if(profile.displayName!==displayName)throw Error('个人资料回执与保存内容不一致，请重试。')
   revision++;publish(profile)
  })
  writing=next
  try{await next}finally{if(writing===next)writing=undefined}
 },dispose:()=>{disposed=true}}
}
