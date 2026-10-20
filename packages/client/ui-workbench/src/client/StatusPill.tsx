import type {ReactNode} from 'react'
import css from './StatusPill.module.css'

/**
 * 统一状态胶囊（1.0 设计 30/13）：进行中=info，已完成/已连接/可引用=good，等待处理/需要授权=warn（只给阻塞），
 * 规划中/草案/已内置=neutral，已取消/暂停/已撤回/暂不支持=muted，失败/不可用=danger（只给错误）。
 * 只呈现状态文字，不是按钮；颜色总与文字同时出现，不单靠颜色表达。
 */
export type StatusPillTone='good'|'info'|'warn'|'neutral'|'muted'|'danger'
export function StatusPill({tone='neutral',children,className,title}:{tone?:StatusPillTone;children:ReactNode;className?:string|undefined;title?:string}){
 return <span className={className?css.pill+' '+className:css.pill} data-tone={tone} title={title}>{children}</span>
}
