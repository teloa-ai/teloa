import clsx from 'clsx';
import { staffAvatarSeed } from './staff-avatar-seed.ts';
import css from './StaffAvatar.module.css';

export type StaffAvatarSize = 'sm' | 'md' | 'lg' | 'xl';

// 六种几何图形照抄原型 `数字员工形象.jsx:16-23` 的 path，只是换成本文件的 CSS 类名。
function Glyph({ shape }: { shape: number }) {
    if (shape === 0) return <circle className={css.avGlyph} cx="46" cy="18" r="17" />;
    if (shape === 1) return <path className={css.avGlyph} d="M32 8 56 46H8Z" />;
    if (shape === 2) return <path className={css.avGlyph} d="M4 48a28 28 0 0 1 56 0Z" />;
    if (shape === 3) return <path className={css.avGlyph} d="M32 2 62 32 32 62 2 32Z" />;
    if (shape === 4) return <path className={css.avGlyph} d="M32 6a26 26 0 1 0 0 52 26 26 0 0 0 0-52Zm0 14a12 12 0 1 1 0 24 12 12 0 0 1 0-24Z" />;
    return <g className={css.avGlyph}><rect x="8" y="38" width="11" height="22" rx="5" /><rect x="26" y="26" width="11" height="34" rx="5" /><rect x="44" y="14" width="11" height="46" rx="5" /></g>;
}

/**
 * 同事形象：底色 + 几何图形 + 首字母，全部本地 SVG，不引用外部图片。
 * `tone`/`shape` 缺省时按 `seed` 稳定派生，同一位同事每次进来都一样；`aria-hidden`——
 * 形象是装饰，名字本身已经在旁边显示（可访问性靠文字名，不靠这个组件）。
 * 分身（`kind==='twin'`）不套本组件，沿用既有 `.avatar` + `Fingerprint` 角标（规格 §4.5.3）。
 */
export function StaffAvatar({ initial, seed, tone, shape, size = 'md' }: {
    initial: string;
    seed: string;
    tone?: number;
    shape?: number;
    size?: StaffAvatarSize;
}): JSX.Element {
    const base = staffAvatarSeed(seed);
    const toneValue = Number.isInteger(tone) ? (tone as number) : base.tone;
    const shapeValue = Number.isInteger(shape) ? (shape as number) : base.shape;
    return <span className={clsx(css.avatarWrap, css['size' + size])} aria-hidden="true">
        <svg viewBox="0 0 64 64" className={clsx(css.avatarSvg, css['tone' + toneValue])}>
            <rect className={css.avBg} x="0" y="0" width="64" height="64" rx="18" />
            <Glyph shape={shapeValue} />
            <text className={css.avText} x="32" y="33" dominantBaseline="middle" textAnchor="middle">{initial}</text>
        </svg>
    </span>;
}
