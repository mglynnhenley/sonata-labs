import { GMAIL_SCOPE } from "./scopes";

// How each scope reads on the consent screen. Wording mirrors the one-liners
// Google shows on its real Gmail consent screen ("Read, compose, and send…"),
// so the mimicry is faithful down to the copy. `icon` is a Material Symbols name.

export interface ScopeConsentInfo {
  title: string;
  icon: string;
}

const INFO: Record<string, ScopeConsentInfo> = {
  [GMAIL_SCOPE.readonly]: { title: "Read your email messages and settings", icon: "drafts" },
  [GMAIL_SCOPE.send]: { title: "Send email on your behalf", icon: "send" },
  [GMAIL_SCOPE.compose]: {
    title: "Manage drafts and send emails",
    icon: "edit_note",
  },
  [GMAIL_SCOPE.modify]: {
    title: "Read, compose, send, and permanently delete all your email from Gmail",
    icon: "mail",
  },
  [GMAIL_SCOPE.labels]: { title: "Manage mailbox labels", icon: "label" },
  [GMAIL_SCOPE.full]: {
    title: "Read, compose, send, and permanently delete all your email from Gmail",
    icon: "all_inbox",
  },
};

export function consentInfoFor(scope: string): ScopeConsentInfo {
  return INFO[scope] ?? { title: scope, icon: "shield" };
}
