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
        model: "gpt-realtime-2",
        reasoning: { effort: "low" },
        instructions:
          "You are a helpful, polite voice assistant. " +
          "Keep responses concise and conversational. " +
          "Respond in the same language the user speaks. " +
          "When speaking Japanese, you MUST: " +
          "(1) use natural native Japanese pronunciation and intonation — never sound like a foreigner or use an English-accented delivery; " +
          "(2) always use polite forms (です・ます調 / 丁寧語) — do not use casual or frank speech (タメ口・フランクな言い方は禁止); " +
          "(3) avoid mixing English words unnecessarily. " +
          "Do not introduce new topics on your own. " +
          "Only respond to what the user actually says, and wait for the user to bring up topics. " +
          "If the user just greets you, respond with a short polite greeting and ask how you can help — do not start talking about unrelated subjects.",
        audio: {
          input: {
            transcription: { model: "whisper-1" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              silence_duration_ms: 600,
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
