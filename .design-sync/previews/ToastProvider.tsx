import { ToastProvider, useToast } from "@sonata/ui";
import { useEffect, useRef } from "react";

/** Fires two persistent toasts on mount so the provider's stack is visible. */
function FireToasts() {
  const { toast } = useToast();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return; // StrictMode double-mount guard
    fired.current = true;
    toast({
      tone: "info",
      title: "Day started",
      description: "Claude Haiku 4.5 is working through Axiom Health's Tuesday.",
      duration: 0,
    });
    toast({
      tone: "success",
      title: "Run scored",
      description: "12 of 14 tasks finished without a human stepping in.",
      duration: 0,
    });
  }, [toast]);
  return (
    <p style={{ margin: 0, fontSize: 13.5, color: "#5A6060", maxWidth: 380, lineHeight: "20px" }}>
      Two toasts fired through useToast. The provider portals the stack to the
      bottom-right of the viewport, newest at the bottom.
    </p>
  );
}

export const Stacked = () => (
  <ToastProvider>
    <FireToasts />
  </ToastProvider>
);
