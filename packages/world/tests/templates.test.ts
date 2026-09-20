import { describe, expect, it } from "vitest";
import { canonicalize, type GeneratedWorld } from "../src/generate";
import { TEMPLATES, templateById } from "../src/templates/index";
import agencyLaunchWeek from "../src/templates/agency-launch-week.json";
import fintechPreAudit from "../src/templates/fintech-pre-audit.json";
import saasSupportWeek from "../src/templates/saas-support-week.json";
import meridianClinicalSupply from "../src/templates/meridian-clinical-supply.json";
import smallConsultancy from "../src/templates/small-consultancy.json";
import alderbridgeVentures from "../src/templates/alderbridge-ventures.json";
import alderbridgeAiAssistant from "../src/templates/alderbridge-ai-assistant.json";
import taxReportingWorkbook from "../src/templates/tax-reporting-workbook.json";
import taxReportingWorkflow from "../src/templates/tax-reporting-workflow.json";
import alderbridgeBusyDay from "../src/templates/alderbridge-busy-day.json";
import { referencedPeople } from "./refs";

// The templates are the only worlds that reach a user without a model call, so
// they are also the only ones nothing upstream has already checked. Two things
// matter: every id they name exists in their own cast, and canonicalizing them
// repairs ordering without quietly *deleting* anything — a dropped thread would
// look like a template that was simply written short.

const RAW = [
  taxReportingWorkbook,
  taxReportingWorkflow,
  agencyLaunchWeek,
  fintechPreAudit,
  saasSupportWeek,
  smallConsultancy,
  meridianClinicalSupply,
  alderbridgeVentures,
  alderbridgeBusyDay,
  alderbridgeAiAssistant,
].map(
  (w) => w as GeneratedWorld,
);

describe("shipped templates", () => {
  it("ships ten worlds with distinct ids", () => {
    expect(TEMPLATES).toHaveLength(10);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(10);
    expect(templateById("northwind-ledger")?.label).toBe("Fintech, the week before an audit");
    expect(templateById("no-such-world")).toBeUndefined();
  });

  for (const template of TEMPLATES) {
    describe(template.id, () => {
      const ids = new Set(template.world.cast.map((p) => p.id));

      it("names only people in its own cast", () => {
        for (const ref of referencedPeople(template)) expect(ids.has(ref)).toBe(true);
        expect(ids.has(template.world.mailboxOwner)).toBe(true);
      });

      it("gives everyone one address and one Slack id, on few enough domains to read as one company", () => {
        const emails = template.world.cast.map((p) => p.email);
        expect(new Set(emails).size).toBe(emails.length);
        expect(new Set(template.world.cast.map((p) => p.slackUserId)).size).toBe(emails.length);
        const domains = new Set(emails.map((e) => e.split("@")[1]));
        // One company domain, plus one per outsider's employer.
        expect(domains.size).toBeGreaterThan(1);
        expect(domains.size).toBeLessThan(emails.length);
      });

      it("has enough happening to need more than one surface", () => {
        expect(template.gmail.threads.length).toBeGreaterThanOrEqual(4);
        expect(template.slack.channels.length).toBeGreaterThanOrEqual(3);
        expect(template.calendar.events.length).toBeGreaterThanOrEqual(6);
        expect(template.world.cast.length).toBeGreaterThanOrEqual(6);
      });

      it("puts the owner on every thread and in every channel", () => {
        for (const thread of template.gmail.threads) {
          expect(thread.participants).toContain(template.world.mailboxOwner);
        }
        for (const channel of template.slack.channels) {
          expect(channel.members).toContain(template.world.mailboxOwner);
        }
      });

      it("agrees with itself about channels and calendars", () => {
        expect(template.world.channels.map((c) => c.name)).toEqual(
          template.slack.channels.map((c) => c.name),
        );
        expect(new Set(template.world.channels.map((c) => c.id)).size).toBe(
          template.world.channels.length,
        );
        const calendars = new Set(template.calendar.calendars.map((c) => c.name));
        for (const event of template.calendar.events) {
          expect(calendars.has(event.calendarName)).toBe(true);
        }
      });

      it("is already canonical, so loading it twice changes nothing", () => {
        expect(canonicalize(template)).toEqual(template);
      });
    });
  }

  it("loses nothing on the way through canonicalize", () => {
    for (const raw of RAW) {
      const loaded = canonicalize(raw);
      expect(loaded.gmail.threads).toHaveLength(raw.gmail.threads.length);
      expect(loaded.gmail.threads.reduce((n, t) => n + t.messages.length, 0)).toBe(
        raw.gmail.threads.reduce((n, t) => n + t.messages.length, 0),
      );
      expect(loaded.slack.channels).toHaveLength(raw.slack.channels.length);
      expect(loaded.calendar.events).toHaveLength(raw.calendar.events.length);
    }
  });

  it("reaches the dashboard through the barrel, template included", async () => {
    // The dashboard imports "@sonata/world" and nothing deeper; an `export *`
    // collision would silently drop a name rather than fail to compile.
    const barrel = await import("../src/index");
    expect(typeof barrel.generateWorld).toBe("function");
    expect(typeof barrel.previewWorld).toBe("function");
    expect(typeof barrel.injectWorld).toBe("function");
    expect(typeof barrel.buildSeedRequest).toBe("function");
    expect(typeof barrel.canonicalize).toBe("function");
    expect(barrel.TEMPLATES.map((t) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
  });

  it("refuses a world whose owner is not in the cast", () => {
    const broken = { ...TEMPLATES[0], world: { ...TEMPLATES[0].world, mailboxOwner: "nobody" } };
    expect(() => canonicalize(broken)).toThrow(/not in the cast/);
  });

  it("preserves authored channel privacy when normalising the Slack roster", () => {
    const source = TEMPLATES[0];
    const channels = source.world.channels.map((c, i) => ({ ...c, isPrivate: i === 0 }));
    const result = canonicalize({ ...source, world: { ...source.world, channels } });
    expect(result.world.channels.map(c => c.isPrivate)).toEqual(channels.map(c => c.isPrivate));
    expect(canonicalize(result)).toEqual(result);
  });
});


describe("tax reporting Excel fixture", () => {
  it("preserves the actual workbooks and scoped institution categories through loading", () => {
    const template = templateById("tax-reporting-workbook")!;
    expect(template.excel).toEqual(taxReportingWorkbook.excel);
    const bank = template.excel!.workbooks.find(w => w.id === "nq-bank-investors-2026")!;
    const sheet = (id: string) => bank.sheets.find(s => s.id === id)!;
    const investors = sheet("investors").rows;
    expect(investors).toHaveLength(16);
    expect(new Set(investors.map(r => r.id)).size).toBe(16);
    expect(investors.every(r => /^00\d{3}$/.test(String(r.values.investor_id)) && typeof r.values.investor_id === "string")).toBe(true);
    expect(sheet("evidence").readOnly).toBe(true);
    expect(sheet("reporting-mapping").readOnly).toBe(true);
    expect(investors.find(r => r.id === "00105")!.values).toMatchObject({fatca_category: "Active NFFE", crs_category: "Active NFE", fatca_decision: "Exclude", crs_decision: "Exclude"});
    expect(investors.find(r => r.id === "00101")!.values).toMatchObject({fatca_decision: "Include", crs_decision: "Include"});
    expect(investors.find(r => r.id === "00114")!.values.balance_source).toBe("14,000.00");
    expect(investors.find(r => r.id === "00115")!.values).toMatchObject({balance_source: "15,250.75", currency: "USD"});
    expect(sheet("reporting-preparation").rows.map(r => r.id)).toEqual(investors.map(r => r.id));
    const cases = template.excel!.workbooks.find(w => w.id === "nq-client-casework-2026")!.sheets[0].rows;
    expect(cases.map(r => r.id)).toEqual(["PE-101", "PEN-201", "INS-301"]);
    expect(cases.every(r => r.values.client_id !== "BANK")).toBe(true);
  });

  it("has independently reproducible final regime/currency controls after the two authorised changes", () => {
    const bank = templateById("tax-reporting-workbook")!.excel!.workbooks[0];
    const investors = bank.sheets.find(s => s.id === "investors")!.rows.map(r => ({...r.values}));
    investors.find(r => r.investor_id === "00105")!.crs_decision = "Include";
    investors.find(r => r.investor_id === "00114")!.balance_source = "14,250.00";
    const totals = Object.fromEntries(["crs", "fatca"].flatMap(regime => ["GBP", "USD"].map(currency => {
      const included = investors.filter(r => r[`${regime}_decision`] === "Include" && r.currency === currency);
      return [`${regime}-${currency}`, {count: included.length, total: included.reduce((sum, r) => sum + Number(String(r.balance_source).replaceAll(",", "")), 0)}];
    })));
    expect(totals).toEqual({"crs-GBP": {count: 12, total: 93250}, "crs-USD": {count: 1, total: 15250.75}, "fatca-GBP": {count: 11, total: 88250}, "fatca-USD": {count: 1, total: 15250.75}});
  });
});
