import {Toast,IconWarningOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import {isContextGoalRequiredError,localizeWorkError} from './i18n/errors.js'
import {useI18n} from './i18n/provider.js'

declare module '@deepseek-ai/dsh-client-ui-slots'{interface SlotMap{'conversation.input.rejection':{kind:'single';scope:'session';owner:{error:unknown;defaultText:string;anchor:HTMLElement|null;onDone:()=>void}}}}

/** 只本地化已知上下文拒绝；未知错误明确沿用本次官方提示，普通本地 notice 不进入此席位。 */
export function PromptRejectionToast({error,defaultText,anchor,onDone}:PropsRuntime<'conversation.input.rejection'>){
 const {locale}=useI18n()
 return <Toast text={isContextGoalRequiredError(error)?localizeWorkError(locale,error):defaultText} icon={<IconWarningOutlineRegular/>} anchor={anchor} onDone={onDone}/>
}
