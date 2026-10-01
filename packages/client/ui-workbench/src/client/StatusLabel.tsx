import {Check, Circle, CircleDashed, CircleMinus, Clock3, Info, Pause, TriangleAlert} from 'lucide-react'
import type {StatusMark} from './status-presentation.js'
import css from './StatusLabel.module.css'

const icons={enabled:Circle,inactive:Circle,paused:Pause,retired:CircleMinus,running:CircleDashed,waiting:Clock3,complete:Check,blocked:TriangleAlert,info:Info}

/** 只画状态，不推断业务含义；颜色、图形与短文字一起表达，非按钮。 */
export function StatusLabel({label,mark='inactive',tone='muted'}:{label:string;mark?:StatusMark;tone?:'good'|'info'|'warn'|'muted'}){
 const Icon=icons[mark]
 return <span className={css.label} data-tone={tone} data-mark={mark}><Icon size={12} aria-hidden="true"/><span>{label}</span></span>
}
