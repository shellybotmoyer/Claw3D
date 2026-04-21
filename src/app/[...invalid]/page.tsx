import { notFound } from "next/navigation";

/**
 * Catches genuinely invalid routes and returns 404.
 * Previously redirected everything to /office, which silently swallowed
 * valid routes like /agents/:agentId before the dynamic route could handle them.
 * Now only catches paths that don't match any other route.
 */
export default function InvalidRoutePage() {
  notFound();
}
