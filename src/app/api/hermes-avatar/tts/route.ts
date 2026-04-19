import { NextResponse } from "next/server";

export const runtime = "nodejs";

type TTSRequestBody = {
  text?: string;
  voice?: string;
  provider?: string;
  speed?: number;
};

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
const MAX_TTS_CHARS = 5_000;

const normalizeText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

const normalizeVoiceSpeed = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1.2, Math.max(0.7, value));
};

const normalizeVoiceId = (value: unknown): string => {
  const explicit = typeof value === "string" && value.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_VOICE_ID;
};

const synthesizeWithElevenLabs = async (
  text: string,
  voiceId: string,
  speed: number
): Promise<Response> => {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY.");
  }
  const response = await fetch(
    `${ELEVENLABS_API_URL}/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_ELEVENLABS_MODEL_ID,
        voice_settings: {
          speed,
        },
      }),
    }
  );
  return response;
};

export async function POST(request: Request) {
  let body: TTSRequestBody;
  try {
    body = (await request.json()) as TTSRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = normalizeText(body.text);
  if (!text) {
    return NextResponse.json({ error: "text is required." }, { status: 400 });
  }
  if (text.length > MAX_TTS_CHARS) {
    return NextResponse.json(
      { error: `text exceeds ${MAX_TTS_CHARS} characters.` },
      { status: 400 }
    );
  }

  const provider = normalizeText(body.provider) || "elevenlabs";
  const voiceId = normalizeVoiceId(body.voice);
  const speed = normalizeVoiceSpeed(body.speed);

  try {
    let upstream: Response;

    if (provider === "elevenlabs") {
      upstream = await synthesizeWithElevenLabs(text, voiceId, speed);
    } else {
      return NextResponse.json(
        { error: `Unsupported TTS provider: ${provider}. Supported: elevenlabs.` },
        { status: 400 }
      );
    }

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => "TTS error");
      console.error("[hermes-avatar/tts] ElevenLabs error:", upstream.status, errorText);
      return NextResponse.json(
        { error: `TTS service error (${upstream.status}).` },
        { status: 502 }
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "TTS synthesis failed.";
    const status = message.includes("Missing ELEVENLABS_API_KEY") ? 503 : 500;
    console.error("[hermes-avatar/tts]", message);
    return NextResponse.json({ error: message }, { status });
  }
}
