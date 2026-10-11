// Author: Dr. Ousmane Barry
/**
 * app/api/verify/route.ts — the server side of the app.
 *
 * This is a Next.js API route: the exported POST function runs on the
 * server whenever the browser sends a POST request to /api/verify.
 *
 * The flow for one verification:
 *   browser sends { image, application data }
 *     -> this route sends the image to the Claude API (vision model)
 *     -> Claude returns a structured transcription of the label
 *     -> lib/verification.ts compares transcription vs application
 *     -> the verdict goes back to the browser as JSON
 *
 * The Anthropic API key is read from the server's environment and is never
 * sent to the browser; the browser only ever talks to this route.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { NextResponse } from "next/server";
import {
  LabelExtractionSchema,
  verifyAgainstApplication,
  type ApplicationData,
} from "@/lib/verification";

// Reads ANTHROPIC_API_KEY from the environment (.env.local).
// Constructed lazily so a missing key surfaces as a clear API error
// instead of a module-load crash.
// 30s timeout (SDK default is 10 min): on locked-down networks a firewall
// that silently drops traffic to api.anthropic.com would otherwise hang the
// request instead of failing with a diagnosable error.
let client: Anthropic | null = null;
function getClient(): Anthropic {
  return (client ??= new Anthropic({ timeout: 30_000, maxRetries: 1 }));
}

// Haiku 4.5 is Anthropic's fastest model — chosen to meet the hard
// "results in under 5 seconds" requirement for a simple extraction task.
// Override with CLAUDE_MODEL=claude-opus-4-8 if accuracy is preferred over speed.
const MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";

// The system prompt is the standing instruction the model reads before
// looking at any image. The key rule: transcribe faithfully, never guess.
// Pass/fail decisions are deliberately NOT the model's job (see
// lib/verification.ts for why).
const SYSTEM_PROMPT =
  "You are assisting TTB label-compliance agents. You read a photo of an " +
  "alcohol beverage label and transcribe specific fields exactly as printed. " +
  "Transcribe faithfully — do not correct spelling, punctuation, or " +
  "capitalization, and never guess at text you cannot read. If a field is " +
  "not visible or not legible, return null for it and describe the problem " +
  "in image_quality_issue.";

// Only image formats the Claude vision API accepts. Checking against this
// allowlist also stops arbitrary values from being forwarded to the API.
const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// Claude's per-image limit is 5 MB, which is ~6.7M base64 characters.
const MAX_IMAGE_BASE64_CHARS = 7_000_000;

interface VerifyRequest {
  imageBase64: string;
  mediaType: string;
  application: ApplicationData;
}

export async function POST(request: Request) {
  // Start the stopwatch first thing: the UI shows this elapsed time to keep
  // the "results in about 5 seconds" requirement honest.
  const started = Date.now();

  // ---- Step 1: read and validate the request from the browser ----
  let body: VerifyRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { imageBase64, mediaType, application } = body ?? ({} as VerifyRequest);
  if (
    typeof imageBase64 !== "string" ||
    !imageBase64 ||
    typeof mediaType !== "string" ||
    !ALLOWED_MEDIA_TYPES.has(mediaType)
  ) {
    return NextResponse.json(
      { error: "Please attach a JPEG, PNG, or WebP photo of the label." },
      { status: 400 }
    );
  }
  // The browser resizes photos to <=1568px JPEG, far below this cap. Reject
  // oversized payloads before forwarding them to the paid API.
  if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    return NextResponse.json(
      { error: "The photo is too large. Please use a smaller image." },
      { status: 413 }
    );
  }
  // Every application field must be a string (or absent) so malformed input
  // gets a clean 400 instead of a crash inside the comparison code.
  if (
    typeof application !== "object" ||
    application === null ||
    Object.entries(application).some(
      ([, v]) => v !== undefined && typeof v !== "string"
    )
  ) {
    return NextResponse.json(
      { error: "Invalid application data." },
      { status: 400 }
    );
  }
  if (!application?.brandName?.trim() || !application?.abv?.trim()) {
    return NextResponse.json(
      { error: "Brand name and alcohol content are required." },
      { status: 400 }
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      {
        error:
          "Server is not configured: set ANTHROPIC_API_KEY in .env.local and restart.",
      },
      { status: 500 }
    );
  }

  try {
    // ---- Step 2: ask Claude to read the label ----
    // messages.parse() sends the image plus our Zod schema; the API
    // guarantees the reply matches the schema ("structured output"), so
    // response.parsed_output is already a typed object, not free text.
    const response = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: "Extract the required fields from this alcohol beverage label.",
            },
          ],
        },
      ],
      output_config: {
        format: zodOutputFormat(LabelExtractionSchema),
      },
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "The image could not be processed. Please try a different photo." },
        { status: 422 }
      );
    }

    const extraction = response.parsed_output;
    if (!extraction) {
      return NextResponse.json(
        { error: "Could not read the label. Please retake the photo and try again." },
        { status: 422 }
      );
    }

    // ---- Step 3: compare the transcription against the application ----
    // Deterministic code (lib/verification.ts) makes the actual decision.
    const result = verifyAgainstApplication(extraction, application);
    return NextResponse.json({
      ...result,
      elapsedMs: Date.now() - started,
      extraction, // included so the UI (and tests) can show what was read
    });
  } catch (error) {
    // ---- Error handling: convert every failure into a plain-language ----
    // message the agent can act on. Technical details go to the server log
    // only, never to the browser.
    if (error instanceof Anthropic.AuthenticationError) {
      return NextResponse.json(
        { error: "Server is not configured: missing or invalid ANTHROPIC_API_KEY." },
        { status: 500 }
      );
    }
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "The system is busy. Please try again in a moment." },
        { status: 503 }
      );
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return NextResponse.json(
        {
          error:
            "Could not reach the verification service (api.anthropic.com). " +
            "If this network restricts outbound traffic, ask IT to allow " +
            "HTTPS to api.anthropic.com, then try again.",
        },
        { status: 502 }
      );
    }
    console.error("Verification error:", error);
    return NextResponse.json(
      { error: "Something went wrong reading the label. Please try again." },
      { status: 502 }
    );
  }
}
