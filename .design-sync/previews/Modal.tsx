import { Button, Modal } from "@sonata/ui";

/**
 * A destructive confirmation that must be answered: dismissible off, so the
 * only ways out are the two buttons. Secondary Cancel, danger confirm last.
 */
export const ReplaceConfirmation = () => (
  <Modal
    open
    onClose={() => {}}
    dismissible={false}
    title="Replace Axiom Health in the clones?"
    description="The Gmail, Slack and Calendar clones for Axiom Health will be rebuilt from the latest snapshot. Runs in progress keep their copies; new runs start from the replacement."
    footer={
      <>
        <Button variant="secondary">Cancel</Button>
        <Button variant="danger">Replace clone</Button>
      </>
    }
  >
    <p style={{ margin: 0, lineHeight: "21px" }}>
      3 scenarios reference this clone — Quarterly close, Support triage and
      Vendor renewal will pick up the new snapshot on their next run.
    </p>
  </Modal>
);
