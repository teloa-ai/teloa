import type {TeloaTranslate} from './i18n/index.js'

export type ContinuousDirectoryMode='saved'|'sandbox'

type Identified={id:string}

export const continuousDirectoryMode=(hasPersistence:boolean):ContinuousDirectoryMode=>hasPersistence?'saved':'sandbox'

export function visiblePreviewPlans<T extends Identified>(plans:readonly T[],savedPlanIds:ReadonlySet<string>,mode:ContinuousDirectoryMode):T[]{
  return plans.filter(plan=>mode==='saved'?savedPlanIds.has(plan.id):!savedPlanIds.has(plan.id))
}

export const continuousModeLabel=(t:TeloaTranslate,mode:ContinuousDirectoryMode):string=>t(`presentation.continuous.mode.${mode}` as Parameters<TeloaTranslate>[0])
