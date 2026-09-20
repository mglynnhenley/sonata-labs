import { SlackApp } from "./_components/SlackApp";

export default function Home() {
  return <SlackApp providerToken={process.env.SANDBOX_TOKEN || "sandbox-token"} controlsAvailable={!process.env.SANDBOX_CONTROL_TOKEN} />;
}
