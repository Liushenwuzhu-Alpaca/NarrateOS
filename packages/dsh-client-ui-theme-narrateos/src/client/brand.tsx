import React from 'react';

export interface NarrateBrandMarkProps {
    size?: number;
}

/**
 * NarrateOS 东方清样朱砂方印徽标。
 * 以微倾 -4deg 的朱砂印泥底托起双页折书与校勘准星线，尺寸随宿主侧栏自适应。
 */
export function NarrateBrandMark({ size = 24 }: NarrateBrandMarkProps): React.ReactElement {
    return (
        <span
            className="ns-theme-brand-mark"
            style={{
                width: `${size}px`,
                height: `${size}px`
            }}
            aria-hidden="true"
        >
            <svg
                width={size}
                height={size}
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
            >
                <rect
                    x="2.2"
                    y="2.2"
                    width="19.6"
                    height="19.6"
                    rx="5.2"
                    transform="rotate(-4 12 12)"
                    fill="#df6447"
                />
                <rect
                    x="3.4"
                    y="3.4"
                    width="17.2"
                    height="17.2"
                    rx="4"
                    transform="rotate(-4 12 12)"
                    stroke="rgba(255, 251, 245, 0.36)"
                    strokeWidth="0.9"
                />
                <path
                    d="M7.5 7.6C9.2 7.2 10.8 7.6 12 8.5C13.2 7.6 14.8 7.2 16.5 7.6V15.8C14.8 15.4 13.2 15.8 12 16.7C10.8 15.8 9.2 15.4 7.5 15.8V7.6Z"
                    stroke="#fcfbf7"
                    strokeWidth="1.45"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <path
                    d="M12 8.5V16.7"
                    stroke="#fcfbf7"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                />
            </svg>
        </span>
    );
}

/**
 * NarrateOS 品牌文字牌：无衬线主名配合极淡等宽清样小标。
 */
export function NarrateBrandName(): React.ReactElement {
    return (
        <span className="ns-theme-brand-wordmark">
            <span className="ns-theme-brand-title">NarrateOS</span>
            <span className="ns-theme-brand-tag">GALLEY</span>
        </span>
    );
}
