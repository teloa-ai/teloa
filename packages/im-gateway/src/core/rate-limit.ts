const windowMs=60_000
/** hits 表的键数上限（审查 L4）：未绑定者、群内他人各占一键，不设上限会随来访者无界增长。 */
const keyMax=1000

/**
 * 按 key 的一分钟滑动窗口限流：窗口内已放行 perMinute 次后 take 返回 false。
 * 键数超过 maxKeys 时先淘汰窗口外的键，仍超出再淘汰最久未放行的键。
 */
export function createRateLimiter(perMinute:number,now:()=>number,maxKeys=keyMax):{take(key:string):boolean;size():number}{
 const hits=new Map<string,number[]>()
 return {
  take(key){
   const t=now()
   const recent=(hits.get(key)??[]).filter(at=>at>t-windowMs)
   if(recent.length>=perMinute){hits.set(key,recent);return false}
   recent.push(t)
   // 重新插入：Map 迭代顺序即最近放行顺序。
   hits.delete(key)
   hits.set(key,recent)
   if(hits.size>maxKeys){
    for(const [stale,times] of hits)if(times.at(-1)!<=t-windowMs)hits.delete(stale)
    while(hits.size>maxKeys)hits.delete(hits.keys().next().value!)
   }
   return true
  },
  size:()=>hits.size,
 }
}
