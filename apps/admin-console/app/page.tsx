import { LiveConsole } from "../components/live-console.tsx";

/** One page; everything on it comes from near-watch through /api/watch/stream and /api/watch/*. */
export default function Page() {
  return <LiveConsole />;
}
