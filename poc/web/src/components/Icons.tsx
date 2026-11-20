import type { ReactNode } from "react";

export type IconName =
  | "menu"
  | "plus"
  | "send"
  | "stop"
  | "x"
  | "refresh"
  | "sun"
  | "moon"
  | "more"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "folder"
  | "clock"
  | "plan"
  | "branch"
  | "download"
  | "archive"
  | "play"
  | "paperclip"
  | "terminal"
  | "image"
  | "search"
  | "copy"
  | "alert";

const paths: Record<IconName, ReactNode> = {
  menu: <path d="M3 6h10M3 10h10M3 14h10" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  send: <path d="M8 13V3.5M4 7l4-3.5L12 7" />,
  stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.4h-2.4" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </>
  ),
  moon: <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3 5.4 5.4 0 1 0 13 9.6Z" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="M3 8.4l3.1 3.1L13 4.6" />,
  "chevron-down": <path d="M4 6l4 4 4-4" />,
  "chevron-right": <path d="M6 4l4 4-4 4" />,
  folder: <path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.4l1.2 1.5H12a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4.5Z" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.2" />
    </>
  ),
  plan: <path d="M4 3.5h8M4 8h8M4 12.5h5" />,
  branch: (
    <>
      <circle cx="4.5" cy="4" r="1.6" />
      <circle cx="4.5" cy="12" r="1.6" />
      <circle cx="11.5" cy="6.5" r="1.6" />
      <path d="M4.5 5.6v4.8M6.1 6.1c2.3.6 3.8 1 3.8 3.6 0 1.7-1.2 2.3-2.6 2.3" />
    </>
  ),
  download: <path d="M8 2.5v7.2M5 7.2l3 3 3-3M3 13h10" />,
  archive: (
    <>
      <rect x="2.5" y="3" width="11" height="3" rx="1" />
      <path d="M3.5 6v6A1.5 1.5 0 0 0 5 13.5h6a1.5 1.5 0 0 0 1.5-1.5V6M6.5 9h3" />
    </>
  ),
  play: <path d="M5 3.5l7 4.5-7 4.5v-9Z" />,
  paperclip: <path d="M11.5 7.2l-4 4a2.2 2.2 0 0 1-3.1-3.1l4.4-4.4a1.5 1.5 0 0 1 2.1 2.1L6.6 10a.8.8 0 0 1-1.1-1.1l3.6-3.6" />,
  terminal: <path d="M3 4.5l4 3.5-4 3.5M8.5 12h4" />,
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.2" r="1.1" />
      <path d="M3.2 11.4l3-3 2.2 2.2 1.6-1.6 2.6 2.6" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="7.5" height="8" rx="1.2" />
      <path d="M10.5 5.5V4a1.2 1.2 0 0 0-1.2-1.2H4.2A1.2 1.2 0 0 0 3 4v6a1.2 1.2 0 0 0 1.2 1.2h1.3" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.8l5.4 9.4H2.6L8 2.8Z" />
      <path d="M8 6.2v3M8 11v.2" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
