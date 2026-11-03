export type ComposerSuggestionEvents={
 subscribe:(listener:()=>void)=>()=>void
 getSnapshot:()=>{entries:readonly {event:{type:string;seq:number;data:unknown;surfaceOp?:unknown}}[]}
}

/** 用原生回复序号绑定候选；未完成、失败或新本人输入立即使旧候选失效。 */
export function readComposerSuggestionAnswer(entries:ReturnType<ComposerSuggestionEvents['getSnapshot']>['entries']):number|null{
 let human=false,answer:{seq:number;turn:number}|null=null,completed:number|null=null
 for(const {event} of entries){
  if(!event.data||typeof event.data!=='object')continue
  const data=event.data as {source?:{kind?:string};turn?:number;interrupted?:boolean;reason?:{kind?:string};message?:{content?:readonly {type:string;text?:string}[]}}
  if(event.type==='user/message'&&event.surfaceOp==='append'&&data.source?.kind==='user'){
   human=true;answer=null;completed=null
  }else if(event.type==='turn/start'){
   answer=null;completed=null
  }else if(event.type==='assistant/message'){
   completed=null
   answer=human&&!data.interrupted&&typeof data.turn==='number'&&data.message?.content?.some(part=>part.type==='text'&&part.text?.trim())?{seq:event.seq,turn:data.turn}:null
  }else if(event.type==='turn/end'){
   completed=data.reason?.kind==='completed'&&answer&&answer.turn===data.turn?answer.seq:null
  }
 }
 return completed
}
