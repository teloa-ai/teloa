import {draftCarry,type DraftInputPort} from './blank-conversation-draft.js'

type Ports={open:()=>Promise<boolean>;current:()=>boolean;input:()=>DraftInputPort|undefined;messages:{unavailable:string;occupied:string;rejected:string}}
export const twinDraftConversationErrorCodes={unavailable:'teloa/twin-draft-open-unavailable',occupied:'teloa/twin-draft-input-occupied',rejected:'teloa/twin-draft-input-rejected'} as const
const failure=(reason:keyof typeof twinDraftConversationErrorCodes,message:string)=>Object.assign(Error(message),{code:twinDraftConversationErrorCodes[reason]})
/** 回到原生来源只保留待发正文；已有输入与后来导航不被覆盖。 */
export async function openTwinDraftConversation(text:string,ports:Ports):Promise<void>{
 if(!ports.current()||!await ports.open()||!ports.current())throw failure('unavailable',ports.messages.unavailable)
 const input=ports.input()
 if(!input)throw failure('unavailable',ports.messages.unavailable)
 const before=input.state.getSnapshot(),kind=draftCarry(before)
 if(kind==='text'&&before.draft===text)return
 if(kind!=='empty')throw failure('occupied',ports.messages.occupied)
 input.setDraft(text)
 if(!ports.current()||input.state.getSnapshot().draft!==text)throw failure('rejected',ports.messages.rejected)
}
