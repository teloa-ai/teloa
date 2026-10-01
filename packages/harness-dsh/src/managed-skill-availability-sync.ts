/** DB 与原生目录没有共同事务：维护期间先关读取，完整刷新成功后才重新开放。 */
export function createManagedAvailabilitySync<Snapshot>(ports:{deny:()=>void;read:()=>Promise<Snapshot>;replace:(snapshot:Snapshot)=>void}){
 let tail:Promise<void>=Promise.resolve()
 function stable<T>(operation:()=>Promise<T>):Promise<T>{
  const result=tail.then(operation)
  tail=result.then(()=>{},()=>{})
  return result
 }
 function change<T>(operation:()=>Promise<T>):Promise<T>{
  return stable(async()=>{
   ports.deny()
   try{return await operation()}
   finally{ports.replace(await ports.read())}
  })
 }
 return {stable,change,refresh:()=>change(async()=>{})}
}
