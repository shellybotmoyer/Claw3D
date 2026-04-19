import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatRequestBody = {
  messages: ChatMessage[];
  persona?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
};

const OLLAMA_BASE_URL = "https://ollama.com/v1";
const DEFAULT_MODEL = "minimax-m2.7";
const MAX_TOKENS = 1024;

const normalizeMessages = (
  messages: unknown
): ChatMessage[] => {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m): m is ChatMessage =>
        m !== null &&
        typeof m === "object" &&
        (m as ChatMessage).role !== undefined &&
        typeof (m as ChatMessage).content === "string"
    )
    .map((m) => ({
      role: m.role === "system" || m.role === "user" || m.role === "assistant" ? m.role : "user",
      content: m.content,
    }));
};

const normalizeString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const normalizeNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

export async function POST(request: Request) {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const messages = normalizeMessages(body.messages);
  if (messages.length === 0) {
    return NextResponse.json({ error: "messages is required and must be non-empty." }, { status: 400 });
  }

  const model = normalizeString(body.model, DEFAULT_MODEL);
  const temperature = normalizeNumber(body.temperature ?? 0.7, 0, 2, 0.7);
  const maxTokens = normalizeNumber(body.max_tokens, 1, 4096, MAX_TOKENS);

  const apiKey = process.env.OLLAMA_API_KEY?.trim();

  try {
    const upstream = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : null),
      } as Record<string, string>,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => "Unknown error");
      console.error("[hermes-avatar/chat] Ollama upstream error:", upstream.status, errorText);
      return NextResponse.json(
        { error: `Chat service error (${upstream.status}).` },
        { status: 502 }
      );
    }

    const data = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (data.error) {
      return NextResponse.json({ error: data.error.message ?? " upstream error." }, { status: 502 });
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    return NextResponse.json(
      {
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      { status: 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat proxy failed.";
    console.error("[hermes-avatar/chat]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
