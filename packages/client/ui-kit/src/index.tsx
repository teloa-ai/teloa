import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** 从原型提取的按钮语义；布局与主题由使用方的 CSS Modules 提供。 */
export function ActionButton({ icon, children, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode }) {
  return <button type={type} {...props}>{icon}{children}</button>
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title}><h2>{title}</h2><p>{children}</p></section>
}
