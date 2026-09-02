import { Table, Badge, Chip, type Column } from "@sonata/ui";

type Run = {
  id: string;
  scenario: string;
  model: string;
  autonomy: string;
  status: "running" | "passed" | "failed";
  when: string;
};

const RUNS: Run[] = [
  { id: "run_a", scenario: "The Final Loop", model: "Claude Haiku 4.5", autonomy: "91%", status: "running", when: "now" },
  { id: "run_b", scenario: "The Final Loop", model: "Claude Opus 5", autonomy: "100%", status: "passed", when: "1 h ago" },
  { id: "run_c", scenario: "Storm Break", model: "GPT-5.4", autonomy: "31%", status: "failed", when: "18 h ago" },
  { id: "run_d", scenario: "Quarter-end invoice chasing", model: "Claude Haiku 4.5", autonomy: "62%", status: "passed", when: "1 d ago" },
];

const LABEL = { running: "Running", passed: "Passed", failed: "Failed" } as const;

const columns: readonly Column<Run>[] = [
  {
    key: "scenario",
    header: "Scenario",
    render: (run) => (
      <div style={{ minWidth: 0 }}>
        <p className="truncate font-bold text-sn-ink">{run.scenario}</p>
        <p className="mt-0.5 text-[12px] text-sn-subtle">{run.model}</p>
      </div>
    ),
  },
  {
    key: "apps",
    header: "Apps",
    width: "150px",
    render: () => (
      <div style={{ display: "flex", gap: 4 }}>
        <Chip service="gmail" size="sm" />
        <Chip service="slack" size="sm" />
      </div>
    ),
  },
  {
    key: "autonomy",
    header: "Autonomy",
    align: "right",
    width: "100px",
    render: (run) => <span data-numeric>{run.autonomy}</span>,
  },
  {
    key: "when",
    header: "When",
    align: "right",
    width: "90px",
    render: (run) => <span className="text-sn-muted">{run.when}</span>,
  },
  {
    key: "status",
    header: "The day",
    align: "right",
    width: "110px",
    render: (run) => (
      <Badge status={run.status} size="sm" dot={run.status === "running"}>
        {LABEL[run.status]}
      </Badge>
    ),
  },
];

/** Rows are real links (`rowHref`), so Cmd-click works; dense by default. */
export const Runs = () => (
  <Table columns={columns} rows={RUNS} rowKey={(run) => run.id} rowHref={(run) => `#${run.id}`} caption="Past runs" />
);

export const Dense = () => (
  <Table columns={columns} rows={RUNS.slice(0, 2)} rowKey={(run) => run.id} dense caption="Past runs, dense" />
);
