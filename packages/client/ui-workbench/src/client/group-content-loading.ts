/** 所有读取并发发出；身份核验后，各部分独立显示，不等最慢的资料口。 */
export function readGroupContentPart<Identity,Value>(identity:Promise<Identity>,value:Promise<Value>,current:()=>boolean,apply:(value:Value)=>void):Promise<Value>{
 return Promise.all([identity,value]).then(([,result])=>{if(current())apply(result);return result})
}
