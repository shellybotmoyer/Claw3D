import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/hermes-avatar/state
 *
 * Returns the current agent state for expression mapping by HermesAvatar.
 * This is a lightweight endpoint that returns static/default state since
 * the hermes-avatar widget drives its own expression logic internally.
 */
export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      timestamp: Date.now(),
      /**
       * The HermesAvatar's ExpressionMapper handles expression logic client-side
       * using the SENTIMENT_MAP in types.ts. This endpoint exists for future
       * cases where the server needs to contribute expression hints.
       */
      expressions: [
        "neutral",
        "happy",
        "sad",
        "angry",
        "surprised",
        "thinking",
        "determined",
        "relaxed",
      ],
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
