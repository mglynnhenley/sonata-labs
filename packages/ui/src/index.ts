/**
 * @sonata/ui — the Sonata Labs design system.
 *
 * Consumed as TypeScript source; apps must list "@sonata/ui" in
 * `transpilePackages` and import "@sonata/ui/styles.css" after Tailwind.
 */

export { cn, type ClassValue } from "./cn";

export {
  buildCssVariables,
  color,
  cssVariables,
  duration,
  easing,
  fontSize,
  layout,
  radius,
  serviceColor,
  shadow,
  space,
  statusColor,
  tokens,
  zIndex,
  SERVICE_IDS,
  SERVICE_LABELS,
  STATUS_LABELS,
  type ServiceId,
  type StatusId,
} from "./tokens";

export { Badge, type BadgeProps, type BadgeSize, type BadgeStatus } from "./components/Badge";
export {
  Button,
  buttonClasses,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from "./components/Button";
export {
  Card,
  type CardPadding,
  type CardProps,
  type CardRadius,
  type CardTone,
} from "./components/Card";
export { Chip, type ChipProps, type ChipSize, type ChipTone } from "./components/Chip";
export { CodeBlock, type CodeBlockProps } from "./components/CodeBlock";
export {
  EmptyState,
  type EmptyStateProps,
  type EmptyStateSize,
} from "./components/EmptyState";
export { Modal, type ModalProps, type ModalSize } from "./components/Modal";
export { PageHeader, type PageHeaderProps } from "./components/PageHeader";
export {
  ProgressBar,
  type ProgressBarProps,
  type ProgressSize,
  type ProgressTone,
} from "./components/ProgressBar";
export {
  Sidebar,
  SidebarGroup,
  SidebarItem,
  SidebarUser,
  type SidebarGroupProps,
  type SidebarItemProps,
  type SidebarProps,
  type SidebarUserProps,
} from "./components/Sidebar";
export { Spinner, type SpinnerProps, type SpinnerSize } from "./components/Spinner";
export { StatCard, type StatCardProps, type StatDelta } from "./components/StatCard";
export { Table, type Column, type TableProps } from "./components/Table";
export {
  TabPanel,
  Tabs,
  tabId,
  tabPanelId,
  type TabItem,
  type TabPanelProps,
  type TabsProps,
  type TabsVariant,
} from "./components/Tabs";
export {
  Timeline,
  TimelineItem,
  type TimelineItemProps,
  type TimelineProps,
  type TimelineTone,
} from "./components/Timeline";
export {
  Toast,
  ToastProvider,
  useToast,
  type ToastOptions,
  type ToastProps,
  type ToastProviderProps,
  type ToastTone,
} from "./components/Toast";

export {
  IconAlert,
  IconArrowDown,
  IconArrowRight,
  IconArrowUp,
  IconBolt,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconClose,
  IconCopy,
  IconDoc,
  IconFeed,
  IconInbox,
  IconInfo,
  IconLayers,
  IconMail,
  IconMessage,
  IconMinus,
  IconPause,
  IconPlay,
  IconSearch,
  IconSpark,
  IconTrend,
  IconUsers,
  type IconProps,
} from "./components/icons";
