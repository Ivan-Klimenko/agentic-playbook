/**
 * Response Output Directives
 *
 * Pattern: Let the agent control output routing via inline directives
 * in its text response — no separate tool calls needed.
 * From: OpenClaw src/auto-reply/reply/reply-directives.ts, reply-delivery.ts
 *
 * Key ideas:
 *   - Inline directives for reply-to, media, silence — parsed from text output
 *   - Random silent token (configurable) — not hardcoded, prevents accidental triggers
 *   - Lazy parsing: only parse if trigger characters detected
 *   - Directives stripped before delivery — user sees clean text
 */

// ─── Types ─────────────────────────────────────────────────────────────────

interface ParsedDirectives {
  text: string;            // Clean text with directives stripped
  replyToId?: string;      // Reply to a specific message ID
  replyToCurrent: boolean; // Reply to the triggering message
  mediaUrls: string[];     // Attached media URLs
  isSilent: boolean;       // Suppress output entirely
  audioAsVoice: boolean;   // Send audio as voice message
}

// ─── Constants ─────────────────────────────────────────────────────────────

const REPLY_TO_CURRENT_TAG = "[[reply_to_current]]";
const REPLY_TO_PREFIX = "[[reply_to:";
const REPLY_TO_SUFFIX = "]]";
const MEDIA_PREFIX = "MEDIA:";

// Default silent token — should be configurable per deployment
const DEFAULT_SILENT_TOKEN = "<<SILENT>>";

// ─── Media Extraction ──────────────────────────────────────────────────────

interface MediaSplit {
  text: string;
  mediaUrls: string[];
  audioAsVoice: boolean;
}

/**
 * Extract MEDIA: directives from text.
 * Format: MEDIA:<url> on its own line.
 * Audio files with VOICE: prefix are flagged for voice message delivery.
 */
function splitMediaFromOutput(raw: string): MediaSplit {
  const lines = raw.split("\n");
  const textLines: string[] = [];
  const mediaUrls: string[] = [];
  let audioAsVoice = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith(MEDIA_PREFIX)) {
      const url = trimmed.slice(MEDIA_PREFIX.length).trim();
      if (url) {
        mediaUrls.push(url);
      }
      continue;
    }

    if (trimmed.startsWith("VOICE:")) {
      const url = trimmed.slice("VOICE:".length).trim();
      if (url) {
        mediaUrls.push(url);
        audioAsVoice = true;
      }
      continue;
    }

    textLines.push(line);
  }

  return {
    text: textLines.join("\n"),
    mediaUrls,
    audioAsVoice,
  };
}

// ─── Reply-To Parsing ──────────────────────────────────────────────────────

interface ReplyParsed {
  text: string;
  replyToId?: string;
  replyToCurrent: boolean;
  hasReplyTag: boolean;
}

function parseInlineDirectives(
  text: string,
  currentMessageId?: string,
): ReplyParsed {
  let result = text;
  let replyToId: string | undefined;
  let replyToCurrent = false;
  let hasReplyTag = false;

  // [[reply_to_current]] — reply to triggering message
  if (result.includes(REPLY_TO_CURRENT_TAG)) {
    result = result.replace(REPLY_TO_CURRENT_TAG, "").trim();
    replyToCurrent = true;
    replyToId = currentMessageId;
    hasReplyTag = true;
  }

  // [[reply_to:<id>]] — reply to specific message
  const replyToMatch = result.match(
    /\[\[reply_to:([^\]]+)\]\]/,
  );
  if (replyToMatch) {
    result = result.replace(replyToMatch[0], "").trim();
    replyToId = replyToMatch[1];
    hasReplyTag = true;
  }

  return { text: result, replyToId, replyToCurrent, hasReplyTag };
}

// ─── Silent Reply Detection ────────────────────────────────────────────────

function isSilentReplyText(text: string, silentToken: string): boolean {
  const trimmed = text.trim();
  // Exact match or text is only the silent token (possibly with whitespace)
  return trimmed === silentToken || trimmed === "";
}

// ─── Main Parser ───────────────────────────────────────────────────────────

/**
 * Parse response output directives from agent text.
 *
 * Lazy parsing: only engage the full parser if trigger characters are detected.
 * This avoids unnecessary work for plain text responses (the common case).
 */
export function parseReplyDirectives(
  raw: string,
  options: {
    currentMessageId?: string;
    silentToken?: string;
  } = {},
): ParsedDirectives {
  const silentToken = options.silentToken ?? DEFAULT_SILENT_TOKEN;

  // Lazy check: skip parsing if no trigger characters present
  const hasTriggers =
    raw.includes("[[") ||
    raw.includes(MEDIA_PREFIX) ||
    raw.includes("VOICE:") ||
    raw.includes(silentToken);

  if (!hasTriggers) {
    return {
      text: raw,
      replyToCurrent: false,
      mediaUrls: [],
      isSilent: false,
      audioAsVoice: false,
    };
  }

  // Full parse
  const mediaSplit = splitMediaFromOutput(raw);
  let text = mediaSplit.text;

  const replyParsed = parseInlineDirectives(text, options.currentMessageId);
  if (replyParsed.hasReplyTag) {
    text = replyParsed.text;
  }

  const isSilent = isSilentReplyText(text, silentToken);
  if (isSilent) {
    text = "";
  }

  return {
    text: text.trim(),
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent,
    mediaUrls: mediaSplit.mediaUrls,
    isSilent,
    audioAsVoice: mediaSplit.audioAsVoice,
  };
}

// ─── Delivery Normalization ────────────────────────────────────────────────

interface DeliveryPayload {
  text: string;
  replyToId?: string;
  mediaUrls: string[];
  isSilent: boolean;
  audioAsVoice: boolean;
}

/**
 * Normalize a response payload by parsing and stripping directives.
 * This is the final step before sending to a channel adapter.
 *
 * The channel adapter receives clean text + structured routing metadata,
 * never raw directive syntax.
 */
export function normalizeForDelivery(
  rawText: string,
  options: {
    currentMessageId?: string;
    silentToken?: string;
    trimLeadingWhitespace?: boolean;
  } = {},
): DeliveryPayload {
  const parsed = parseReplyDirectives(rawText, options);

  let text = parsed.text;
  if (options.trimLeadingWhitespace) {
    text = text.replace(/^\s+/, "");
  }

  return {
    text,
    replyToId: parsed.replyToId,
    mediaUrls: parsed.mediaUrls,
    isSilent: parsed.isSilent,
    audioAsVoice: parsed.audioAsVoice,
  };
}

// ─── Usage Example ─────────────────────────────────────────────────────────

/*
// Agent output with directives:
const agentOutput = `[[reply_to_current]]
Here's the chart you requested:
MEDIA:https://cdn.example.com/chart.png

The data shows a 15% increase in Q4.`;

const parsed = parseReplyDirectives(agentOutput, {
  currentMessageId: "msg_abc123",
});
// Result:
// {
//   text: "Here's the chart you requested:\n\nThe data shows a 15% increase in Q4.",
//   replyToId: "msg_abc123",
//   replyToCurrent: true,
//   mediaUrls: ["https://cdn.example.com/chart.png"],
//   isSilent: false,
//   audioAsVoice: false,
// }

// Silent response (agent decides not to reply):
const silent = parseReplyDirectives("<<SILENT>>");
// silent.isSilent === true, silent.text === ""

// Plain text (no directives — fast path):
const plain = parseReplyDirectives("Just a normal response.");
// No parsing overhead — trigger characters not detected

// Normalize for channel delivery:
const delivery = normalizeForDelivery(agentOutput, {
  currentMessageId: "msg_abc123",
  trimLeadingWhitespace: true,
});
// Channel adapter receives clean text + routing metadata
*/
