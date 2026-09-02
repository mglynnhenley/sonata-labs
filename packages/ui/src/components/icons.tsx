import type { ReactNode, SVGProps } from "react";

/**
 * A tiny hand-rolled icon set. The twins use Material Symbols and Slack's own
 * glyphs to look like the real thing; the dashboard must not, so it carries its
 * own 1.5px stroke set rather than pulling in an icon dependency.
 */

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function makeIcon(name: string, children: ReactNode, filled = false) {
  const Icon = ({ size = 16, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

export const IconCheck = makeIcon("IconCheck", <path d="M20 6 9 17l-5-5" />);

export const IconClose = makeIcon("IconClose", <path d="M18 6 6 18M6 6l12 12" />);

export const IconCopy = makeIcon(
  "IconCopy",
  <>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5 15a2 2 0 0 1-1-1.7V6a2 2 0 0 1 2-2h7.3A2 2 0 0 1 15 5" />
  </>,
);

export const IconChevronRight = makeIcon("IconChevronRight", <path d="m9 6 6 6-6 6" />);

export const IconChevronDown = makeIcon("IconChevronDown", <path d="m6 9 6 6 6-6" />);

export const IconArrowUp = makeIcon("IconArrowUp", <path d="M12 19V5m0 0-6 6m6-6 6 6" />);

export const IconArrowDown = makeIcon("IconArrowDown", <path d="M12 5v14m0 0 6-6m-6 6-6-6" />);

export const IconArrowRight = makeIcon("IconArrowRight", <path d="M5 12h14m0 0-6-6m6 6-6 6" />);

export const IconMinus = makeIcon("IconMinus", <path d="M6 12h12" />);

export const IconPlay = makeIcon("IconPlay", <path d="M7 4.5v15l13-7.5-13-7.5Z" />, true);

export const IconPause = makeIcon(
  "IconPause",
  <>
    <rect x="6" y="5" width="4" height="14" rx="1.2" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" />
  </>,
  true,
);

export const IconClock = makeIcon(
  "IconClock",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </>,
);

export const IconMail = makeIcon(
  "IconMail",
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m3.8 7 7.1 5.1a2 2 0 0 0 2.2 0L20.2 7" />
  </>,
);

export const IconMessage = makeIcon(
  "IconMessage",
  <path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5H5l-2 2v-9.5A7.5 7.5 0 0 1 10.5 5h2A7.5 7.5 0 0 1 20 12.5Z" />,
);

export const IconCalendar = makeIcon(
  "IconCalendar",
  <>
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path d="M3.5 10h17M8 3.5V6.5M16 3.5V6.5" />
  </>,
);

// The two newer twins. Each says what the surface IS rather than whose logo it
// is — a CRM is people, Docs is a page of text — because the set has to read at
// 13px in a timeline marker.
export const IconUsers = makeIcon(
  "IconUsers",
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <path d="M16 5.2a3.5 3.5 0 0 1 0 5.6M18 20a6 6 0 0 0-2.5-4.9" />
  </>,
);

export const IconDoc = makeIcon(
  "IconDoc",
  <>
    <path d="M6 3.5h7L18.5 9v11.5h-12.5Z" />
    <path d="M13 3.5V9h5.5M9 13h6M9 16.5h6" />
  </>,
);

export const IconSearch = makeIcon(
  "IconSearch",
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </>,
);

export const IconSpark = makeIcon(
  "IconSpark",
  <path d="M12 3.5c.6 4.2 1.8 5.4 6 6-4.2.6-5.4 1.8-6 6-.6-4.2-1.8-5.4-6-6 4.2-.6 5.4-1.8 6-6Z" />,
  true,
);

export const IconAlert = makeIcon(
  "IconAlert",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.8v5M12 16.2h.01" />
  </>,
);

export const IconInfo = makeIcon(
  "IconInfo",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.2M12 7.8h.01" />
  </>,
);

export const IconBolt = makeIcon(
  "IconBolt",
  <path d="M13.5 2.5 4.8 13.2a.6.6 0 0 0 .5 1h5.2l-1 7.3 8.7-10.7a.6.6 0 0 0-.5-1h-5.2l1-7.3Z" />,
  true,
);

export const IconInbox = makeIcon(
  "IconInbox",
  <>
    <path d="M3.5 13h4l1.2 2.4h6.6L16.5 13h4" />
    <path d="M4.6 6.2 3.5 13v4.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V13l-1.1-6.8A2 2 0 0 0 17.4 4.5H6.6a2 2 0 0 0-2 1.7Z" />
  </>,
);

export const IconLayers = makeIcon(
  "IconLayers",
  <>
    <path d="m12 3.5 8.5 4.3L12 12 3.5 7.8 12 3.5Z" />
    <path d="m3.5 12.2 8.5 4.3 8.5-4.3M3.5 16.4l8.5 4.3 8.5-4.3" />
  </>,
);
