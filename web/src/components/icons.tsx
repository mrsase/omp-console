import type { ReactNode } from "react";

export function Icon({
  name,
  size = 16,
  label,
}: {
  name:
    | "traces"
    | "plus"
    | "search"
    | "close"
    | "paperclip"
    | "slash"
    | "send"
    | "stop"
    | "chevron"
    | "settings"
    | "plan"
    | "more"
    | "resume"
    | "folder"
    | "up"
    | "check"
    | "theme"
    | "menu"
    | "panel";
  size?: number;
  label?: string;
}): ReactNode {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": label ? undefined : true,
    role: label ? "img" : undefined,
    "aria-label": label,
  };
  switch (name) {
    case "traces":
      return (
        <svg {...common} viewBox="0 0 20 20">
          <path d="M3 6h14M3 10h9M3 14h5" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M8 3v10M3 8h10" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.2" />
          <path d="m10 10 3.5 3.5" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      );
    case "paperclip":
      return (
        <svg {...common}>
          <path d="M11 5.5 6.2 10.3a2 2 0 0 0 2.8 2.8l4.6-4.6a3.2 3.2 0 0 0-4.5-4.5L4.4 8.7a4.4 4.4 0 0 0 6.2 6.2" />
        </svg>
      );
    case "slash":
      return (
        <svg {...common}>
          <path d="M10 3 6 13" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M3 8h9M8 4l4 4-4 4" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m6 4 4 4-4 4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1" />
        </svg>
      );
    case "plan":
      return (
        <svg {...common}>
          <path d="M3 4h10M3 8h10M3 12h6" />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case "resume":
      return (
        <svg {...common}>
          <path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v4h4" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M2.5 4.5h4l1.2 1.6h5.8v6.4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
        </svg>
      );
    case "up":
      return (
        <svg {...common}>
          <path d="M8 12V4M4.5 7.5 8 4l3.5 3.5" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m3.5 8.5 3 3 6-7" />
        </svg>
      );
    case "theme":
      return (
        <svg {...common}>
          <path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5A4 4 0 0 1 8 2.5z" />
        </svg>
      );
    case "menu":
      return (
        <svg {...common}>
          <path d="M3 4.5h10M3 8h10M3 11.5h10" />
        </svg>
      );
    case "panel":
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1" />
          <path d="M10 3v10" />
        </svg>
      );
    default:
      return null;
  }
}
