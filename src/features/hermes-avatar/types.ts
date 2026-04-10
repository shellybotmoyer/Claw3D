/**
 * HermesAvatar Types
 * Configuration, state, and message types for the embeddable avatar widget.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface HermesAvatarConfig {
  /** VRM model URL (local path or remote) */
  modelUrl: string;
  /** API base URL for chat and TTS endpoints */
  apiBaseUrl: string;
  /** Display name for the AI persona */
  personaName?: string;
  /** TTS provider: "elevenlabs" | "openai" | "proxy" | "none" */
  ttsProvider?: string;
  /** Voice ID for TTS */
  voiceId?: string;
  /** Whether to auto-play TTS on response */
  autoSpeak?: boolean;
  /** Whether the chat panel is visible */
  showChat?: boolean;
  /** Whether orbit controls are enabled on the avatar */
  enableOrbitControls?: boolean;
  /** Background color for the 3D stage */
  backgroundColor?: string;
  /** Custom system prompt override */
  systemPrompt?: string;
  /** Maximum chat history length */
  maxHistoryLength?: number;
}

export const DEFAULT_CONFIG: Required<Omit<HermesAvatarConfig, "systemPrompt">> & {
  systemPrompt?: string;
} = {
  modelUrl: "/avatars/Avatar_Orion.vrm",
  apiBaseUrl: "/api/hermes-avatar",
  personaName: "Phil",
  ttsProvider: "elevenlabs",
  voiceId: "21m00Tcm4TlvDq8ikWAM",
  autoSpeak: true,
  showChat: true,
  enableOrbitControls: false,
  backgroundColor: "#1a1a2e",
  maxHistoryLength: 50,
  systemPrompt: undefined,
};

// ============================================================================
// Chat Messages
// ============================================================================

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** Attached avatar commands that should execute alongside this message */
  avatarCommands?: AvatarCommandHint[];
}

export interface AvatarCommandHint {
  /** Expression to play */
  expression?: string;
  /** Pose to set */
  pose?: string;
  /** Gesture to play */
  gesture?: string;
  /** Body motion to apply */
  motion?: string;
}

// ============================================================================
// Chat State
// ============================================================================

export type ChatStatus = "idle" | "thinking" | "streaming" | "speaking" | "error";

export interface ChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
}

// ============================================================================
// TTS
// ============================================================================

export interface TTSRequest {
  text: string;
  voice?: string;
  provider?: string;
  speed?: number;
}

// ============================================================================
// Expression Mapping
// ============================================================================

export interface SentimentResult {
  expression: string;
  pose?: string;
  gesture?: string;
  confidence: number;
}

/** Keywords/sentiment patterns mapped to avatar states */
export const SENTIMENT_MAP: Record<string, SentimentResult> = {
  greeting: { expression: "happy", gesture: "wave", confidence: 0.8 },
  farewell: { expression: "sad", gesture: "wave", confidence: 0.7 },
  agreement: { expression: "happy", pose: "relaxed", confidence: 0.7 },
  disagreement: { expression: "thinking", confidence: 0.6 },
  thinking: { expression: "thinking", confidence: 0.8 },
  excitement: { expression: "very-happy", confidence: 0.8 },
  concern: { expression: "sad", confidence: 0.6 },
  surprise: { expression: "surprised", confidence: 0.8 },
  determination: { expression: "determined", confidence: 0.7 },
  humor: { expression: "very-happy", confidence: 0.7 },
  neutral: { expression: "neutral", confidence: 0.5 },
  error: { expression: "surprised", confidence: 0.5 },
};

// ============================================================================
// PostMessage Protocol (iframe/web-component control)
// ============================================================================

export const HERMES_AVATAR_SOURCE = "hermes-avatar";

export interface HermesAvatarPostMessage {
  source: typeof HERMES_AVATAR_SOURCE;
  id?: string;
  /** Send a chat message */
  chat?: string;
  /** Direct avatar command (from xlunar format) */
  command?: {
    type: string;
    id?: string;
    [key: string]: unknown;
  };
  /** Get current state */
  getState?: boolean;
  /** Configure the avatar */
  configure?: Partial<HermesAvatarConfig>;
}

export interface HermesAvatarStateResponse {
  source: "hermes-avatar-response";
  id?: string;
  state?: {
    chatStatus: ChatStatus;
    messageCount: number;
    avatarReady: boolean;
    currentExpression: string | null;
    currentPose: string | null;
  };
  error?: string;
}