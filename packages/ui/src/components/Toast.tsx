"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn";
import { IconAlert, IconCheck, IconClose, IconInfo } from "./icons";

export type ToastTone = "info" | "success" | "error";

export type ToastOptions = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds. 0 keeps it up until dismissed. */
  duration?: number;
  action?: { label: string; onClick: () => void };
};

type ToastRecord = ToastOptions & { id: string };

const TONES: Record<ToastTone, { wrap: string; icon: ReactNode }> = {
  info: { wrap: "border-sn-line", icon: <IconInfo size="md" className="text-sn-info" /> },
  success: {
    wrap: "border-sn-passed-line",
    icon: <IconCheck size="md" className="text-sn-success" />,
  },
  error: { wrap: "border-sn-failed-line", icon: <IconAlert size="md" className="text-sn-danger" /> },
};

export type ToastProps = {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
  className?: string;
};

/** A single toast. Usable standalone; ToastProvider is the normal route. */
export function Toast({ toast, onDismiss, className }: ToastProps) {
  const tone = TONES[toast.tone ?? "info"];
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className={cn(
        // 336px plus the stack's 20px insets needs 376px of viewport. On a 375px
        // phone the toast hung off the right edge, so it caps to the space there
        // actually is.
        "animate-sn-pop pointer-events-auto flex w-[min(336px,calc(100vw-2.5rem))] items-start gap-2.5 rounded-sn-xl border bg-sn-surface p-3 shadow-sn-lg",
        tone.wrap,
        className,
      )}
    >
      <span className="mt-0.5 shrink-0">{tone.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sn-base font-medium text-sn-ink">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 text-sn-base text-sn-muted">{toast.description}</p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="mt-2 rounded-sn-sm text-sn-base font-medium text-sn-primary-ink underline-offset-2 hover:underline"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="-m-1 shrink-0 rounded-sn-sm p-1 text-sn-subtle transition-colors duration-150 ease-sn hover:bg-sn-bg-subtle hover:text-sn-ink"
      >
        <IconClose size="sm" />
      </button>
    </div>
  );
}

type ToastApi = {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export type ToastProviderProps = {
  children: ReactNode;
  /** Oldest are dropped past this. */
  max?: number;
  defaultDuration?: number;
};

export function ToastProvider({ children, max = 4, defaultDuration = 5000 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = `sn-toast-${Math.random().toString(36).slice(2, 10)}`;
      setToasts((current) => [...current, { ...options, id }].slice(-max));
      const duration = options.duration ?? defaultDuration;
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [defaultDuration, dismiss, max],
  );

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted
        ? createPortal(
            <div
              aria-live="polite"
              // The bottom inset clears the iOS home indicator; without it the
              // newest toast sits under the gesture bar.
              className="pointer-events-none fixed right-5 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-[70] flex flex-col-reverse gap-2.5"
            >
              {toasts.map((t) => (
                <Toast key={t.id} toast={t} onDismiss={dismiss} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

/** Throws if used outside ToastProvider — a silent no-op toast is worse. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
