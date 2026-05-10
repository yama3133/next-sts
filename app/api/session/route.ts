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

  const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-realtime-preview",
      voice,
      instructions:
        "You are a helpful, friendly voice assistant. " +
        "Keep responses concise and conversational. " +
        "Respond in the same language the user speaks.",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
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
