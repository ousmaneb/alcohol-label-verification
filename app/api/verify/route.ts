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

const SYSTEM_PROMPT =
  "You are assisting TTB label-compliance agents. You read a photo of an " +
  "alcohol beverage label and transcribe specific fields exactly as printed. " +
  "Transcribe faithfully — do not correct spelling, punctuation, or " +
  "capitalization, and never guess at text you cannot read. If a field is " +
  "not visible or not legible, return null for it and describe the problem " +
  "in image_quality_issue.";

const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

interface VerifyRequest {
  imageBase64: string;
  mediaType: string;
  application: ApplicationData;
}

export async function POST(request: Request) {
  const started = Date.now();

  let body: VerifyRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { imageBase64, mediaType, application } = body;
  if (!imageBase64 || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return NextResponse.json(
      { error: "Please attach a JPEG, PNG, or WebP photo of the label." },
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

    const result = verifyAgainstApplication(extraction, application);
    return NextResponse.json({
      ...result,
      elapsedMs: Date.now() - started,
      extraction,
    });
  } catch (error) {
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
