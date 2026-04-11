/**
 * ExpressionMapper — Maps text sentiment/content to avatar expressions, poses, and gestures.
 *
 * Analyzes assistant response text for emotional cues and produces avatar command hints.
 * Uses keyword matching + pattern detection. Can be upgraded to use an LLM for richer mapping.
 */

import type { AvatarCommandHint, SentimentResult } from "./types";
import { SENTIMENT_MAP } from "./types";

// Keyword patterns for sentiment detection
const KEYWORD_PATTERNS: Array<{ pattern: RegExp; sentiment: string }> = [
  // Greetings
  { pattern: /\b(hello|hi|hey|greetings|good morning|good evening|welcome)\b/i, sentiment: "greeting" },
  // Farewells
  { pattern: /\b(goodbye|bye|see you|farewell|take care|good night)\b/i, sentiment: "farewell" },
  // Agreement
  { pattern: /\b(yes|absolutely|exactly|right|correct|agreed|sure|indeed|definitely|totally)\b/i, sentiment: "agreement" },
  // Disagreement
  { pattern: /\b(no|wrong|incorrect|disagree|not really|actually|however|but)\b/i, sentiment: "disagreement" },
  // Thinking
  { pattern: /\b(hmm|let me think|considering|analyzing|calculating|pondering|i wonder)\b/i, sentiment: "thinking" },
  // Excitement
  { pattern: /\b(amazing|awesome|fantastic|incredible|excellent|great news|wonderful|thrilled)\b/i, sentiment: "excitement" },
  // Concern
  { pattern: /\b(sorry|unfortunately|concern|worry|problem|issue|error|failed|trouble)\b/i, sentiment: "concern" },
  // Surprise
  { pattern: /\b(wow|unexpected|surprising|whoa|didn't expect|remarkable)\b/i, sentiment: "surprise" },
  // Determination
  { pattern: /\b(will|shall|determined|committed|resolve|ensure|guarantee|make sure)\b/i, sentiment: "determination" },
  // Humor
  { pattern: /\b(haha|lol|funny|joke|pun|humor|amusing|😆|😂|🤣)\b/i, sentiment: "humor" },
];

/**
 * Analyze text and return the most appropriate avatar command hints.
 */
export function mapResponseToCommands(text: string): AvatarCommandHint[] {
  const commands: AvatarCommandHint[] = [];

  // Score each sentiment by how many patterns match
  const scores: Record<string, number> = {};
  for (const { pattern, sentiment } of KEYWORD_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      scores[sentiment] = (scores[sentiment] || 0) + matches.length;
    }
  }

  // Also check for question marks = thinking
  if (text.includes("?")) {
    scores.thinking = (scores.thinking || 0) + 0.5;
  }

  // Check for exclamation marks = excitement or emphasis
  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations > 1) {
    scores.excitement = (scores.excitement || 0) + exclamations * 0.3;
  }

  // Sort by score descending
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  // Take top 2 sentiments
  for (let i = 0; i < Math.min(sorted.length, 2); i++) {
    const [sentiment] = sorted[i];
    const mapping = SENTIMENT_MAP[sentiment];
    if (mapping) {
      commands.push({
        expression: mapping.expression,
        pose: mapping.pose,
        gesture: mapping.gesture,
        motion: undefined,
      });
    }
  }

  // Default: neutral expression
  if (commands.length === 0) {
    commands.push({ expression: "neutral" });
  }

  // The first command gets the primary expression + pose + gesture
  // Return only the strongest one for clarity
  return [commands[0]];
}

/**
 * Simple sentiment from a single chunk during streaming.
 * Used for real-time expression updates as text arrives.
 */
export function quickSentiment(chunk: string): SentimentResult {
  // Fast check on the latest chunk
  if (/[!?]{2,}/.test(chunk)) return SENTIMENT_MAP.excitement;
  if (/\bhmm\b/i.test(chunk)) return SENTIMENT_MAP.thinking;
  if (/\byes\b|\babsolutely\b|\bsure\b/i.test(chunk)) return SENTIMENT_MAP.agreement;
  if (/\bno\b|\bwrong\b/i.test(chunk)) return SENTIMENT_MAP.disagreement;
  return SENTIMENT_MAP.neutral;
}