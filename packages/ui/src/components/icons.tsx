import type { ReactNode, SVGProps } from "react";

/**
 * A tiny hand-rolled icon set. The twins use Material Symbols and Slack's own
 * glyphs to look like the real thing; the dashboard must not, so it carries its
 * own 1.5px stroke set rather than pulling in an icon dependency.
 */

/**
 * Four steps, mirroring `iconSize` in tokens.ts. A raw number is still allowed
 * for the rare glyph that has to match a specific piece of type, but the named
 * step is the default — eight ad-hoc sizes across the app was not a scale.
 */
export const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 20 } as const;

export type IconSize = keyof typeof ICON_SIZE;

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: IconSize | number;
};

function makeIcon(name: string, children: ReactNode, filled = false) {
  const Icon = ({ size = "md", ...rest }: IconProps) => {
    const px = typeof size === "number" ? size : ICON_SIZE[size];
    return (
    <svg
      width={px}
      height={px}
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
  };
  Icon.displayName = name;
  return Icon;
}

export const IconCheck = makeIcon("IconCheck", <path d="M20 6 9 17l-5-5" />);

export const IconClose = makeIcon("IconClose", <path d="M18 6 6 18M6 6l12 12" />);

export const IconMenu = makeIcon("IconMenu", <path d="M4 7h16M4 12h16M4 17h16" />);

export const IconGear = makeIcon(
  "IconGear",
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.2 12a7.2 7.2 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.2 7.2 0 0 0-2-1.2L14.2 3h-4l-.5 2.6a7.2 7.2 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.2 7.2 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.2 7.2 0 0 0 2 1.2l.5 2.6h4l.5-2.6a7.2 7.2 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2Z" />
  </>,
);

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

// The four newer twins. Each says what the surface IS rather than whose logo it
// is — a CRM is people, Docs is a page of text, Ads is a spend line, LinkedIn is
// a feed post — because the set has to read at 13px in a timeline marker.
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

export const IconTrend = makeIcon(
  "IconTrend",
  <>
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="m7.5 15 3.5-4 3 2.5 5-6" />
    <path d="M19 7.5h-3.5M19 7.5V11" />
  </>,
);

export const IconFeed = makeIcon(
  "IconFeed",
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M7.5 9.5h4M7.5 13h9M7.5 16h6" />
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

// ---------------------------------------------------------------------------
// Service logos. Monochrome silhouettes of the real marks, so a chip reads as
// "Gmail" at a glance while staying in the palette — the tint comes from the
// chip's own service ink, never from vendor brand colours.
// ---------------------------------------------------------------------------

export const LogoGmail = makeIcon(
  "LogoGmail",
  <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.6L12 9.4 18.9 4h1.6A1.5 1.5 0 0 1 22 5.5v13a1.5 1.5 0 0 1-1.5 1.5H18V8.9l-6 4.6-6-4.6V20H3.5A1.5 1.5 0 0 1 2 18.5v-13Z" />,
  true,
);

export const LogoSlack = makeIcon(
  "LogoSlack",
  <path d="M5.04 15.17a2.52 2.52 0 1 1-2.52-2.53h2.52v2.53Zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.31a2.52 2.52 0 1 1-5.04 0v-6.31ZM8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83Zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 1 1 0-5.04h6.31Zm10.13 2.52a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83Zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 1 1 5.04 0v6.31Zm-2.52 10.13a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52Zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 1 1 0 5.04h-6.31Z" />,
  true,
);

export const LogoGoogleCalendar = makeIcon(
  "LogoGoogleCalendar",
  <path
    fillRule="evenodd"
    d="M7.5 2a1 1 0 0 1 1 1v1h7V3a1 1 0 1 1 2 0v1h1A2.5 2.5 0 0 1 21 6.5v12a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5v-12A2.5 2.5 0 0 1 5.5 4h1V3a1 1 0 0 1 1-1ZM5 9v9.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V9H5Zm6.2 2.4c-.5.3-1 .5-1.6.6v1.3h1.5v4h1.7v-5.9h-1.6Z"
  />,
  true,
);

export const LogoAttio = makeIcon(
  "LogoAttio",
  <path d="M12 2.5 21.5 21.5h-4l-2-4.2H8.5l-2 4.2h-4L12 2.5Zm0 7.2-2.1 4.5h4.2L12 9.7Z" />,
  true,
);

export const LogoGoogleDocs = makeIcon(
  "LogoGoogleDocs",
  <path
    fillRule="evenodd"
    d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7.5 1.8V8a1 1 0 0 0 1 1h4.2L13.5 3.8ZM8 12h8v1.6H8V12Zm0 3h8v1.6H8V15Zm0 3h5.5v1.6H8V18Z"
  />,
  true,
);

export const LogoGoogleAds = makeIcon(
  "LogoGoogleAds",
  <>
    <circle cx="4.6" cy="18.4" r="3.1" />
    <path d="M9.3 3.6a3.1 3.1 0 0 1 4.24 1.13l8.04 13.9a3.1 3.1 0 1 1-5.37 3.1L8.17 7.85A3.1 3.1 0 0 1 9.3 3.6Z" />
    <path d="M8.17 7.85l5.37 3.1-4.6 7.96a3.1 3.1 0 0 0-4.28-4.24l3.51-6.82Z" />
  </>,
  true,
);

export const LogoLinkedIn = makeIcon(
  "LogoLinkedIn",
  <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.55V9h3.57v11.45ZM22.23 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.23 0Z" />,
  true,
);

export const LogoExcel = makeIcon(
  "LogoExcel",
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </>,
);
