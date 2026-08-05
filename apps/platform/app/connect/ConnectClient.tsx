"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Chip,
  CodeBlock,
  IconAlert,
  IconArrowRight,
  IconBolt,
  IconCheck,
  IconClose,
  IconSpark,
  PageHeader,
  TabPanel,
  Tabs,
  buttonClasses,
  useToast,
  type TabItem,
} from "@sonata/ui";
import { ROUTES } from "@/lib/routes";
import type { TwinStatus } from "@/lib/twins";
import { TwinStrip } from "../_components/TwinStrip";
import { useGo } from "../_components/useGo";
import { usePoll } from "../_components/usePoll";
import type { ConnectionView } from "./_lib/connection";
import type { ConnectTest } from "./_lib/handshake";

// Step one of three: point your agent at the fake company.
//
// The page is ordered the way the job is done — start the clones, paste one line,
// prove it works — and the third step is the one that earns the page. Everything
// before it is a promise; the test is the only part that can be checked before a
// user has wired up an agent of their own, and a connector you cannot check
// before you commit to it is a connector people abandon at the first silence.

/** The clones move when you press Start, so the strip has to keep up. */
const POLL_MS = 2500;

const HOW_IT_WORKS = [
  {
    title: "Connect",
    body: "Paste one line into your agent. It gets a mailbox, a Slack workspace and a calendar that behave like the real ones and reach nothing outside this machine.",
  },
  {
    title: "Start a day",
    body: "Pick a scenario and press go. Mail arrives, people post, meetings move — on a compressed clock, whether or not your agent happens to be looking.",
  },
  {
    title: "Read the report",
    body: "Your agent works the day however it likes. Everything it touches is recorded, and at the end you get a scored report on what it actually did.",
  },
] as const;

type TabId = "claude" | "json" | "rest";

const TABS: readonly TabItem[] = [
  { id: "claude", label: "Claude Code" },
  { id: "json", label: "MCP config" },
  { id: "rest", label: "Plain HTTP" },
];

const TAB_HINTS: Record<TabId, string> = {
  claude:
    "Run this from the directory your agent works in. Claude Code, Cowork and anything else that speaks the claude mcp add command will pick the tools up on its next session.",
  json: "Paste this into your agent's MCP config — Cursor, Windsurf, Claude Desktop, OpenClaw, anything that reads an mcpServers block.",
  rest: "No MCP? The clones are ordinary HTTP APIs shaped like Gmail, Slack and Google Calendar. Same surface, same audit log, same report at the end.",
};

const TAB_LANGUAGE: Record<TabId, string> = { claude: "bash", json: "json", rest: "text" };

function isTabId(value: string): value is TabId {
  return value === "claude" || value === "json" || value === "rest";
}

function snippetFor(connection: ConnectionView, tab: TabId): string {
  if (tab === "claude") return connection.snippets.claudeCode;
  if (tab === "json") return connection.snippets.mcpJson;
  return connection.snippets.rest;
}

/** "12 for Gmail, 8 for Slack and 7 for the calendar" — what the count is made of. */
function inventoryLine(connection: ConnectionView): string {
  const parts = connection.perTwin.map((t) => `${t.count} for ${t.label}`);
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("");
  const cross = connection.crossTwin.join(", ");
  return cross
    ? `${connection.toolTotal} tools: ${listed}, plus ${cross}, which checks all three at once.`
    : `${connection.toolTotal} tools: ${listed}.`;
}

export interface ConnectClientProps {
  connection: ConnectionView;
  initialTwins: TwinStatus[];
}

interface Payload {
  connection: ConnectionView;
  twins: TwinStatus[];
}

export function ConnectClient({ connection, initialTwins }: ConnectClientProps) {
  const go = useGo();
  const { toast } = useToast();
  const [tab, setTab] = useState<TabId>("claude");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ConnectTest | null>(null);

  const poll = usePoll<Payload>("/api/connect", POLL_MS, { connection, twins: initialTwins });
  const twins = poll.data.twins;
  const live = poll.data.connection;
  const ready = twins.filter((t) => t.ok).length;
  const allUp = twins.length > 0 && ready === twins.length;

  async function testConnection() {
    setTesting(true);
    try {
      const res = await fetch("/api/connect/test", { method: "POST" });
      const body = (await res.json()) as { test?: ConnectTest; error?: string };
      if (!res.ok || !body.test) throw new Error(body.error ?? `${res.status}`);
      setTest(body.test);
    } catch (err) {
      toast({
        title: "The test could not run",
        description: (err as Error).message,
        tone: "error",
        duration: 0,
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        eyebrow="Step 1 of 3"
        title="Connect your agent"
        size="lg"
        subtitle="Your agent stays where it is. Sonata never calls it — you point it at three clones of the tools a real assistant uses, and it works inside them on its own."
        meta={
          <>
            <Badge status={allUp ? "passed" : ready > 0 ? "warning" : "neutral"}>
              {twins.length === 0
                ? "Checking the clones"
                : `${ready} of ${twins.length} clones ready`}
            </Badge>
            <span className="text-[12px] text-sn-subtle">{inventoryLine(live)}</span>
          </>
        }
      />

      {/* What happens next, before anything is asked of the user. */}
      <section aria-labelledby="how-it-works">
        <h2 id="how-it-works" className="text-[14px] font-medium text-sn-ink">
          How this works
        </h2>
        <ol className="mt-3 grid gap-4 md:grid-cols-3">
          {HOW_IT_WORKS.map((step, i) => (
            <li key={step.title}>
              <Card padding="md" tone="sunken" className="h-full">
                <div className="flex items-center gap-2.5">
                  <span
                    data-numeric
                    className="grid h-6 w-6 place-items-center rounded-full bg-sn-primary-soft text-[12px] font-medium text-sn-primary-ink"
                  >
                    {i + 1}
                  </span>
                  <h3 className="text-[14px] font-medium text-sn-ink">{step.title}</h3>
                </div>
                <p className="mt-2.5 text-[13px] leading-[20px] text-sn-muted">{step.body}</p>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="clones">
        <h2 id="clones" className="text-[14px] font-medium text-sn-ink">
          The three clones
        </h2>
        <p className="mt-1.5 max-w-[62ch] text-[13px] leading-[20px] text-sn-muted">
          Each one is a local server your agent talks to over its normal API. They have to be
          running before anything can connect — start any that are off, right here.
        </p>
        <div className="mt-4">
          <TwinStrip twins={twins} onChanged={poll.refresh} />
        </div>
        {poll.error ? (
          <p className="mt-3 text-[12px] text-sn-subtle">
            The dashboard stopped hearing back a moment ago; the state above may be behind.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="snippet">
        <h2 id="snippet" className="text-[14px] font-medium text-sn-ink">
          Point your agent at them
        </h2>
        <p className="mt-1.5 max-w-[62ch] text-[13px] leading-[20px] text-sn-muted">
          One connection, all three clones. Nothing is required of your agent beyond using the
          tools — no callbacks, no SDK, no changes to how it runs.
        </p>

        {!live.binInstalled ? (
          <Card padding="sm" tone="sunken" className="mt-4 flex items-start gap-2.5">
            <IconAlert size={15} className="mt-0.5 shrink-0 text-sn-warning" />
            <p className="text-[13px] leading-[20px] text-sn-muted">
              <span className="font-medium text-sn-ink">The launcher is not installed yet.</span>{" "}
              The command below is right, but{" "}
              <code className="font-mono text-[12px] text-sn-ink">{live.command}</code> does not
              exist until you run <code className="font-mono text-[12px] text-sn-ink">npm install</code>{" "}
              in <code className="font-mono text-[12px] text-sn-ink">{live.repoRoot}</code>.
            </p>
          </Card>
        ) : null}

        <div className="mt-4">
          <Tabs
            items={TABS}
            value={tab}
            onValueChange={(id) => {
              if (isTabId(id)) setTab(id);
            }}
            idPrefix="connect"
            label="Connection formats"
          />
          {TABS.map((item) => {
            const id = item.id;
            if (!isTabId(id)) return null;
            return (
              <TabPanel key={id} id={id} active={tab === id} idPrefix="connect" className="pt-4">
                <p className="max-w-[70ch] text-[13px] leading-[20px] text-sn-muted">
                  {TAB_HINTS[id]}
                </p>
                <CodeBlock
                  className="mt-3"
                  code={snippetFor(live, id)}
                  language={TAB_LANGUAGE[id]}
                  wrap={id !== "json"}
                  maxHeight="320px"
                />
              </TabPanel>
            );
          })}
        </div>

        <p className="mt-3 text-[12px] leading-[19px] text-sn-subtle">
          The clones answer to the token in the snippet (
          <code className="font-mono text-[11px]">{live.token}</code>), and they answer to nothing
          outside this machine. Your agent will see the server as{" "}
          <code className="font-mono text-[11px]">{live.serverName}</code>.
        </p>
      </section>

      <section aria-labelledby="test">
        <h2 id="test" className="text-[14px] font-medium text-sn-ink">
          Check it worked
        </h2>
        <p className="mt-1.5 max-w-[62ch] text-[13px] leading-[20px] text-sn-muted">
          This connects the way your agent will and reports what came back — so you know the wiring
          is good before you touch your own setup.
        </p>

        <Card padding="md" className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {test ? (
                <div className="flex items-start gap-2.5">
                  {test.ok ? (
                    <IconCheck size={16} className="mt-0.5 shrink-0 text-sn-success" />
                  ) : (
                    <IconAlert size={16} className="mt-0.5 shrink-0 text-sn-warning" />
                  )}
                  <p className="text-[14px] leading-[21px] text-sn-ink">{test.headline}</p>
                </div>
              ) : (
                <div className="flex items-start gap-2.5">
                  <IconSpark size={16} className="mt-0.5 shrink-0 text-sn-subtle" />
                  <p className="text-[14px] leading-[21px] text-sn-muted">
                    Not tested yet. One call per clone, through the same tools your agent gets —
                    it changes nothing.
                  </p>
                </div>
              )}
            </div>
            <Button
              variant="primary"
              loading={testing}
              onClick={() => void testConnection()}
              icon={<IconBolt size={14} />}
            >
              {test ? "Test again" : "Test the connection"}
            </Button>
          </div>

          {test ? (
            <ul className="mt-4 flex flex-col gap-2.5 border-t border-sn-line pt-4">
              {test.checks.map((check) => (
                // Fixed columns, not flex: three chips of different widths would
                // leave the sentences that matter starting at three different
                // places, and the eye reads the ragged edge before the words.
                <li
                  key={check.tool}
                  className="grid grid-cols-[14px_84px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 sm:grid-cols-[14px_84px_minmax(0,1fr)_auto]"
                >
                  {check.ok ? (
                    <IconCheck size={14} className="mt-1 text-sn-success" />
                  ) : (
                    <IconClose size={14} className="mt-1 text-sn-danger" />
                  )}
                  <Chip service={check.twin} size="sm" className="justify-self-start" />
                  <span className="min-w-0 text-[13px] leading-[22px] text-sn-ink">
                    {check.detail}
                  </span>
                  <span className="col-start-3 text-[12px] leading-[22px] text-sn-subtle sm:col-start-4 sm:text-right">
                    <code className="font-mono text-[11px]">{check.tool}</code>
                    <span data-numeric className="ml-2">
                      {check.ms}ms
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </section>

      <section aria-labelledby="next">
        <h2 id="next" className="text-[14px] font-medium text-sn-ink">
          Then start a day
        </h2>
        <p className="mt-1.5 max-w-[62ch] text-[13px] leading-[20px] text-sn-muted">
          With the agent connected, the rest is the other two steps: choose what the day throws at
          it, then read what it did.
        </p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          {/* Real anchors wearing the button's clothes, so middle-click and
              "copy link address" keep working on the page's main exits. */}
          <a
            href={ROUTES.scenarios}
            onClick={(e) => go(e, ROUTES.scenarios)}
            className={buttonClasses("primary", "md")}
          >
            Choose a scenario
            <IconArrowRight size={13} />
          </a>
          <a
            href={ROUTES.results}
            onClick={(e) => go(e, ROUTES.results)}
            className={buttonClasses("secondary", "md")}
          >
            See a finished report
            <IconArrowRight size={13} />
          </a>
        </div>
      </section>
    </div>
  );
}
