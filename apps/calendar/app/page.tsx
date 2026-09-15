import { CalendarApp } from "./_components/CalendarApp";
import { controlToken } from "@sonata/core/controlAuth";

export const dynamic = "force-dynamic";

export default function Home() {
  return <CalendarApp activityToken={process.env.SANDBOX_CONTROL_TOKEN ? null : controlToken()} />;
}
