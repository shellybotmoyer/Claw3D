"use client";

/**
 * HermesBridge — Connects the avatar to the Hermes/Honcho backend.
 *
 * Handles:
 * 1. Chat completion (streaming) via /api/hermes-avatar/chat
 * 2. TTS synthesis via /api/hermes-avatar/tts
 * 3. Agent state polling via /api/hermes-avatar/state
 */

import type { ChatMessage, ChatStatus, TTSRequest } from "../types";

export interface HermesBridgeOptions {
  apiBaseUrl: string;
  personaName?: string;
  systemPrompt?: string;
}

export class HermesBridge {
  private apiBaseUrl: string;
  private personaName: string;
  private systemPrompt: string | undefined;
  private abortController: AbortController | null = null;

  constructor(options: HermesBridgeOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.personaName = options.personaName || "Phil";
    this.systemPrompt = options.systemPrompt;
  }

  /**
   * Send a chat message and stream the response.
   * Yields text chunks as they arrive, then yields a final { done: true } marker.
   */
  async *streamChat(
    messages: ChatMessage[],
    userMessage: string,
    signal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const payload = {
      messages: [
        ...(this.systemPrompt
          ? [{ role: "system" as const, content: this.systemPrompt }]
          : []),
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: userMessage },
      ],
      persona: this.personaName,
    };

    const response = await fetch(`${this.apiBaseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Chat failed (${response.status}): ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) yield content;
            } catch {
              // Not JSON — yield as plain text
              if (data) yield data;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Non-streaming chat — returns the full response at once.
   */
  async chat(messages: ChatMessage[], userMessage: string): Promise<string> {
    let fullResponse = "";
    for await (const chunk of this.streamChat(messages, userMessage)) {
      fullResponse += chunk;
    }
    return fullResponse;
  }

  /**
   * Synthesize speech from text via TTS endpoint.
   * Returns a Blob URL for audio playback.
   */
  async synthesizeSpeech(request: TTSRequest): Promise<string> {
    const response = await fetch(`${this.apiBaseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "TTS error");
      throw new Error(`TTS failed (${response.status}): ${errorText}`);
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  /**
   * Fetch agent state for expression mapping.
   */
  async fetchAgentState(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.apiBaseUrl}/state`, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`State fetch failed (${response.status})`);
    }

    return response.json();
  }

  /**
   * Abort any ongoing streaming request.
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Update configuration.
   */
  updateConfig(options: Partial<HermesBridgeOptions>): void {
    if (options.apiBaseUrl) this.apiBaseUrl = options.apiBaseUrl;
    if (options.personaName) this.personaName = options.personaName;
    if (options.systemPrompt !== undefined) this.systemPrompt = options.systemPrompt;
  }
}