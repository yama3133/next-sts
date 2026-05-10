"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

type Status =
  | "idle"
  | "fetching_token"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

type Voice = "alloy" | "ash" | "coral" | "echo" | "sage" | "shimmer";

interface VoiceOption {
  id: Voice;
  label: string;
  description: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VOICES: VoiceOption[] = [
  { id: "alloy",   label: "Alloy",   description: "中性的・落ち着いた" },
  { id: "ash",     label: "Ash",     description: "ソフト・明瞭" },
  { id: "coral",   label: "Coral",   description: "フレンドリー・明るい" },
  { id: "echo",    label: "Echo",    description: "男性的・深み" },
  { id: "sage",    label: "Sage",    description: "知的・穏やか" },
  { id: "shimmer", label: "Shimmer", description: "女性的・温かみ" },
];

const STATUS_LABEL: Record<Status, string> = {
  idle: "READY",
  fetching_token: "INIT...",
  connecting: "CONNECTING",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
  error: "ERROR",
};

const BAR_COUNT = 40;

// ─── Component ────────────────────────────────────────────────────────────────

export default function Page() {
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [bars, setBars] = useState<number[]>(Array(BAR_COUNT).fill(2));
  const [selectedVoice, setSelectedVoice] = useState<Voice>("coral");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animRef = useRef<number>(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  // ── Waveform animation ────────────────────────────────────────────────────

  const animateWave = useCallback(() => {
    animRef.current = requestAnimationFrame(animateWave);
    if (!analyserRef.current) {
      setBars(Array(BAR_COUNT).fill(2));
      return;
    }
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    const step = Math.floor(data.length / BAR_COUNT);
    setBars(
      Array.from({ length: BAR_COUNT }, (_, i) =>
        Math.max(2, (data[i * step] / 255) * 72)
      )
    );
  }, []);

  useEffect(() => {
    animRef.current = requestAnimationFrame(animateWave);
    return () => cancelAnimationFrame(animRef.current);
  }, [animateWave]);

  // ── Auto-scroll transcript ────────────────────────────────────────────────

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Upsert message helper ─────────────────────────────────────────────────

  const upsertMsg = useCallback(
    (id: string, role: "user" | "assistant", text: string, final: boolean) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) return [...prev, { id, role, text, final }];
        const next = [...prev];
        next[idx] = { ...next[idx], text, final };
        return next;
      });
    },
    []
  );

  // ── OpenAI Realtime event handler ─────────────────────────────────────────

  const handleRealtimeEvent = useCallback(
    (ev: Record<string, unknown>) => {
      const type = ev.type as string;

      switch (type) {
        case "input_audio_buffer.speech_started":
          setStatus("listening");
          break;
        case "response.created":
          setStatus("thinking");
          break;
        case "response.audio.delta":
          setStatus("speaking");
          break;
        case "conversation.item.input_audio_transcription": {
          const item = ev.item as Record<string, unknown> | undefined;
          const itemId = (ev.item_id ?? "user-live") as string;
          const text = (item?.transcript ?? "") as string;
          if (text) upsertMsg(itemId, "user", text, false);
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const itemId = (ev.item_id ?? "user-live") as string;
          const transcript = (ev.transcript ?? "") as string;
          if (transcript) upsertMsg(itemId, "user", transcript, true);
          break;
        }
        case "response.audio_transcript.delta": {
          const itemId = (ev.item_id ?? "ai-live") as string;
          const delta = (ev.delta ?? "") as string;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === itemId);
            if (idx === -1)
              return [...prev, { id: itemId, role: "assistant", text: delta, final: false }];
            const next = [...prev];
            next[idx] = { ...next[idx], text: next[idx].text + delta };
            return next;
          });
          break;
        }
        case "response.audio_transcript.done": {
          const itemId = (ev.item_id ?? "ai-live") as string;
          const transcript = (ev.transcript ?? "") as string;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === itemId);
            if (idx === -1)
              return [...prev, { id: itemId, role: "assistant", text: transcript, final: true }];
            const next = [...prev];
            next[idx] = { ...next[idx], text: transcript, final: true };
            return next;
          });
          break;
        }
        case "response.done":
          setStatus("listening");
          break;
        case "input_audio_buffer.speech_stopped":
          setStatus("listening");
          break;
        case "error": {
          const err = ev.error as Record<string, unknown> | undefined;
          setErrorMsg(String(err?.message ?? "Unknown error from OpenAI"));
          setStatus("error");
          break;
        }
      }
    },
    [upsertMsg]
  );

  // ── Start session ──────────────────────────────────────────────────────────

  const startSession = useCallback(async () => {
    setStatus("fetching_token");
    setErrorMsg("");

    let ephemeralKey: string;
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: selectedVoice }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      ephemeralKey = data.client_secret?.value;
      if (!ephemeralKey) throw new Error("No client_secret in response");
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
      return;
    }

    setStatus("connecting");
    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioElRef.current = audioEl;

    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(e.streams[0]);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyserRef.current = analyser;
    };

    let localStream: MediaStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setErrorMsg("Microphone access denied: " + String(e));
      setStatus("error");
      pc.close();
      return;
    }
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;

    dc.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        handleRealtimeEvent(ev);
      } catch {}
    };

    dc.onopen = () => {
      setStatus("listening");
      dc.send(
        JSON.stringify({
          type: "session.update",
          session: { input_audio_transcription: { model: "whisper-1" } },
        })
      );
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch(
      "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      }
    );

    if (!sdpRes.ok) {
      const body = await sdpRes.text();
      setErrorMsg(`OpenAI SDP error: ${sdpRes.status} ${body}`);
      setStatus("error");
      pc.close();
      return;
    }

    const answerSdp = await sdpRes.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        stopSession();
      }
    };
  }, [handleRealtimeEvent, selectedVoice]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Stop session ──────────────────────────────────────────────────────────

  const stopSession = useCallback(() => {
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    analyserRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current = null;
    }
    setStatus("idle");
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const active = status !== "idle" && status !== "error";

  return (
    <div style={styles.root}>
      {/* ── Header ── */}
      <header style={styles.header}>
        <div style={styles.logo}>
          <span style={styles.logoAccent}>//</span> VOICE AGENT
        </div>
        <div
          style={{
            ...styles.statusChip,
            ...(status === "listening" ? styles.chipListening : {}),
            ...(status === "speaking" ? styles.chipSpeaking : {}),
            ...(status === "error" ? styles.chipError : {}),
          }}
        >
          <span
            style={{
              ...styles.dot,
              background:
                status === "listening"
                  ? "var(--user-col)"
                  : status === "speaking"
                  ? "var(--ai-col)"
                  : status === "error"
                  ? "#c83030"
                  : "var(--ink-muted)",
            }}
          />
          {STATUS_LABEL[status]}
        </div>
      </header>

      {/* ── Body ── */}
      <main style={styles.main}>
        {/* Left: Visualizer + controls */}
        <div style={styles.visualizerPanel}>
          <div style={styles.gridDeco} aria-hidden />

          {/* Waveform */}
          <div style={styles.waveWrap}>
            {bars.map((h, i) => (
              <div
                key={i}
                style={{
                  ...styles.bar,
                  height: `${h}px`,
                  background:
                    status === "speaking"
                      ? "var(--ai-col)"
                      : status === "listening"
                      ? "var(--user-col)"
                      : "var(--ink-muted)",
                  opacity: active ? 1 : 0.3,
                  transition: "height 0.08s ease, background 0.3s ease, opacity 0.3s ease",
                }}
              />
            ))}
          </div>

          {/* Status label */}
          <div style={styles.waveLabel}>
            {status === "idle" && "話者を選んで START を押してください"}
            {status === "fetching_token" && "初期化中…"}
            {status === "connecting" && "接続中…"}
            {status === "listening" && "聞いています — お話しください"}
            {status === "thinking" && "処理中…"}
            {status === "speaking" && "エージェントが話しています"}
            {status === "error" && errorMsg}
          </div>

          {/* ── Voice selector ── */}
          {!active && (
            <div style={styles.voiceGrid}>
              {VOICES.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setSelectedVoice(v.id)}
                  style={{
                    ...styles.voiceCard,
                    ...(selectedVoice === v.id ? styles.voiceCardActive : {}),
                  }}
                >
                  <span style={styles.voiceLabel}>{v.label}</span>
                  <span style={styles.voiceDesc}>{v.description}</span>
                </button>
              ))}
            </div>
          )}

          {/* Active: show selected voice badge */}
          {active && (
            <div style={styles.voiceBadge}>
              <span style={styles.voiceBadgeDot} />
              {VOICES.find((v) => v.id === selectedVoice)?.label}
            </div>
          )}

          {/* Controls */}
          <div style={styles.controls}>
            {!active ? (
              <button
                style={styles.btnStart}
                onClick={startSession}
                disabled={["fetching_token", "connecting"].includes(status)}
              >
                {(["fetching_token","connecting"] as string[]).includes(status) ? "…" : "START"}
              </button>
            ) : (
              <button style={styles.btnStop} onClick={stopSession}>
                STOP
              </button>
            )}
            <button
              style={styles.btnClear}
              onClick={() => setMessages([])}
              disabled={messages.length === 0}
            >
              CLEAR LOG
            </button>
          </div>
        </div>

        {/* Right: Transcript */}
        <div style={styles.transcriptPanel}>
          <div style={styles.transcriptHeader}>
            <span>TRANSCRIPT</span>
            <span style={{ color: "var(--ink-muted)", fontSize: "0.7rem" }}>
              {messages.length} turn{messages.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div style={styles.log} ref={logRef}>
            {messages.length === 0 ? (
              <div style={styles.emptyHint}>Conversation will appear here</div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  style={{ ...styles.message, opacity: m.final ? 1 : 0.65 }}
                >
                  <div
                    style={{
                      ...styles.messageRole,
                      color: m.role === "user" ? "var(--user-col)" : "var(--ai-col)",
                    }}
                  >
                    {m.role === "user" ? "YOU" : VOICES.find((v) => v.id === selectedVoice)?.label ?? "AGENT"}
                    {!m.final && <span style={styles.partialBadge}>●●●</span>}
                  </div>
                  <div style={styles.messageText}>{m.text}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer style={styles.footer}>
        <span style={{ color: "var(--ink-muted)" }}>
          OpenAI Realtime API · WebRTC · Next.js on Vercel
        </span>
      </footer>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    height: "100vh",
    background: "var(--bg)",
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
  },

  // Header
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 32px",
    borderBottom: "1px solid var(--border-strong)",
    background: "var(--bg)",
  },
  logo: {
    fontFamily: "var(--font-display)",
    fontWeight: 800,
    fontSize: "1.1rem",
    letterSpacing: "0.12em",
    color: "var(--ink)",
  },
  logoAccent: { color: "var(--accent)", marginRight: "6px" },
  statusChip: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 14px",
    border: "1px solid var(--border-strong)",
    borderRadius: "2px",
    fontSize: "0.68rem",
    letterSpacing: "0.14em",
    color: "var(--ink-dim)",
    background: "transparent",
    fontFamily: "var(--font-mono)",
    transition: "all 0.3s ease",
  },
  chipListening: { borderColor: "var(--user-col)", color: "var(--user-col)" },
  chipSpeaking:  { borderColor: "var(--ai-col)",   color: "var(--ai-col)"   },
  chipError:     { borderColor: "#c83030",          color: "#c83030"          },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    flexShrink: 0,
    transition: "background 0.3s",
  },

  // Main
  main: {
    display: "grid",
    gridTemplateColumns: "1fr 360px",
    overflow: "hidden",
  },

  // Visualizer
  visualizerPanel: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "24px",
    padding: "40px",
    position: "relative",
    overflow: "hidden",
  },
  gridDeco: {
    position: "absolute",
    inset: 0,
    backgroundImage:
      "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
    backgroundSize: "40px 40px",
    opacity: 0.5,
    pointerEvents: "none",
  },
  waveWrap: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    height: "80px",
    position: "relative",
    zIndex: 1,
  },
  bar: {
    width: "4px",
    borderRadius: "2px",
    flexShrink: 0,
  },
  waveLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    color: "var(--ink-dim)",
    letterSpacing: "0.06em",
    textAlign: "center",
    maxWidth: "360px",
    position: "relative",
    zIndex: 1,
    minHeight: "1.4em",
  },

  // Voice selector grid
  voiceGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "8px",
    width: "100%",
    maxWidth: "420px",
    position: "relative",
    zIndex: 1,
  },
  voiceCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "3px",
    padding: "10px 8px",
    background: "transparent",
    border: "1px solid var(--border-strong)",
    borderRadius: "2px",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    transition: "all 0.15s ease",
  },
  voiceCardActive: {
    background: "var(--ink)",
    borderColor: "var(--ink)",
    color: "var(--bg)",
  },
  voiceLabel: {
    fontFamily: "var(--font-display)",
    fontWeight: 700,
    fontSize: "0.8rem",
    letterSpacing: "0.08em",
  },
  voiceDesc: {
    fontSize: "0.62rem",
    letterSpacing: "0.04em",
    opacity: 0.65,
  },

  // Active voice badge
  voiceBadge: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 12px",
    border: "1px solid var(--border-strong)",
    borderRadius: "2px",
    fontSize: "0.7rem",
    letterSpacing: "0.1em",
    color: "var(--ink-dim)",
    fontFamily: "var(--font-display)",
    fontWeight: 700,
    position: "relative",
    zIndex: 1,
  },
  voiceBadgeDot: {
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    background: "var(--ai-col)",
  },

  // Controls
  controls: {
    display: "flex",
    gap: "12px",
    position: "relative",
    zIndex: 1,
  },
  btnStart: {
    padding: "14px 48px",
    background: "var(--ink)",
    color: "var(--bg)",
    border: "none",
    borderRadius: "2px",
    fontFamily: "var(--font-display)",
    fontWeight: 700,
    fontSize: "0.9rem",
    letterSpacing: "0.18em",
    cursor: "pointer",
    transition: "opacity 0.2s",
  },
  btnStop: {
    padding: "14px 48px",
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: "2px",
    fontFamily: "var(--font-display)",
    fontWeight: 700,
    fontSize: "0.9rem",
    letterSpacing: "0.18em",
    cursor: "pointer",
    transition: "opacity 0.2s",
  },
  btnClear: {
    padding: "14px 20px",
    background: "transparent",
    color: "var(--ink-dim)",
    border: "1px solid var(--border-strong)",
    borderRadius: "2px",
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    letterSpacing: "0.1em",
    cursor: "pointer",
    transition: "background 0.2s",
  },

  // Transcript
  transcriptPanel: {
    borderLeft: "1px solid var(--border-strong)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--bg2)",
  },
  transcriptHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: "1px solid var(--border-strong)",
    fontFamily: "var(--font-display)",
    fontWeight: 700,
    fontSize: "0.7rem",
    letterSpacing: "0.18em",
    color: "var(--ink-dim)",
  },
  log: {
    flex: 1,
    overflowY: "auto",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  emptyHint: {
    color: "var(--ink-muted)",
    fontSize: "0.8rem",
    textAlign: "center",
    margin: "auto",
    fontStyle: "italic",
    opacity: 0.7,
  },
  message: {
    display: "flex",
    flexDirection: "column",
    gap: "5px",
    transition: "opacity 0.3s",
  },
  messageRole: {
    fontSize: "0.62rem",
    letterSpacing: "0.14em",
    fontFamily: "var(--font-display)",
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  partialBadge: {
    fontSize: "0.5rem",
    letterSpacing: "0.05em",
    opacity: 0.6,
  },
  messageText: {
    fontSize: "0.83rem",
    lineHeight: 1.65,
    color: "var(--ink)",
    background: "var(--bg)",
    padding: "10px 14px",
    borderRadius: "2px",
    border: "1px solid var(--border)",
    fontFamily: "var(--font-mono)",
  },

  // Footer
  footer: {
    padding: "12px 32px",
    borderTop: "1px solid var(--border)",
    fontSize: "0.68rem",
    letterSpacing: "0.06em",
    fontFamily: "var(--font-mono)",
    display: "flex",
    alignItems: "center",
  },
};
