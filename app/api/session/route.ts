import { NextResponse } from "next/server";

const ALLOWED_VOICES = ["alloy", "ash", "coral", "echo", "sage", "shimmer"] as const;
type Voice = (typeof ALLOWED_VOICES)[number];

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  let voice: Voice = "coral";
  try {
    const body = await req.json();
    if (ALLOWED_VOICES.includes(body.voice)) voice = body.voice;
  } catch {}

  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime",
        instructions:
          "You are a helpful, polite voice assistant. " +
          "Keep responses concise and conversational. " +
          "Respond in the same language the user speaks. " +
          "When speaking Japanese, you MUST: " +
          "(1) use natural native Japanese pronunciation and intonation — never sound like a foreigner or use an English-accented delivery; " +
          "(2) always use polite forms (です・ます調 / 丁寧語) — do not use casual or frank speech (タメ口・フランクな言い方は禁止); " +
          "(3) avoid mixing English words unnecessarily. " +
          "CRITICAL behavior rules: " +
          "- NEVER speak unless the user has clearly addressed you with a question or request. " +
          "- NEVER introduce topics on your own (especially do not start explaining technical subjects like CPU, programming, etc. unless the user explicitly asks). " +
          "- If you only hear silence, background noise, or unclear audio, STAY SILENT and wait. Do NOT generate a response. " +
          "- If the user just greets you, respond with a short polite greeting (one sentence) and ask how you can help. " +
          "- Keep every response under 2 sentences unless the user explicitly asks for detail. " +
          "- If unsure what the user said, ask a short clarifying question instead of guessing and elaborating.",
        audio: {
          input: {
            transcription: { model: "whisper-1" },
            turn_detection: {
              type: "semantic_vad",
            },
          },
          output: { voice },
        },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json(
      { error: `OpenAI error: ${res.status} ${body}` },
      { status: res.status }
    );
  }

  const data = await res.json();
  return NextResponse.json(data);
}
