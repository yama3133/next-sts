# next-sts — Speech-to-Speech Voice Agent on Vercel

OpenAI Realtime API (WebRTC) + Next.js App Router + Vercel で動く
フルスタック STS（Speech-to-Speech）アプリです。

## アーキテクチャ

```
Browser (Mic / Speaker)
  │
  │  ① POST /api/session  → Client Secret 発行
  ▼
Vercel API Route (app/api/session/route.ts)
  │  POST https://api.openai.com/v1/realtime/client_secrets
  │  OPENAI_API_KEY はここだけが持つ（クライアントに渡さない）
  │
  │  ② WebRTC SDP Offer/Answer
  ▼
OpenAI Realtime API (https://api.openai.com/v1/realtime/calls)
  │  音声ストリーム（双方向）+ イベント DataChannel
  ▼
Browser Audio Context（再生 / 波形表示）
```

- **Vercel Functions** : Client Secret 発行のみ（WebSocket 不要）
- **WebRTC** : ブラウザ ↔ OpenAI 間の低遅延音声ストリーム
- **DataChannel** : OpenAI Realtime イベント（transcript / VAD 等）の送受信

### 使用 API エンドポイント（GA版）

| 用途 | エンドポイント |
|---|---|
| Client Secret 発行（サーバー） | `POST /v1/realtime/client_secrets` |
| WebRTC SDP 交換（ブラウザ） | `POST /v1/realtime/calls` |

## ローカル開発

```bash
# 1. 依存インストール
npm install

# 2. 環境変数
cp env.local.example .env.local
# .env.local を開いて OPENAI_API_KEY を記入

# 3. 開発サーバー
npm run dev
# → http://localhost:3000
```

## Vercel へのデプロイ

```bash
# Vercel CLI をインストール（未導入の場合）
npm i -g vercel

# デプロイ（初回は対話式セットアップ）
vercel

# 環境変数を Vercel プロジェクトに設定
vercel env add OPENAI_API_KEY
# → プロンプトにしたがって値を貼り付け（Production / Preview / Development すべて選択）

# 本番デプロイ
vercel --prod
```

### Vercel Dashboard から設定する場合

1. https://vercel.com/dashboard → プロジェクト → **Settings** → **Environment Variables**
2. `OPENAI_API_KEY` を追加（Environment: Production）
3. **Redeploy** を実行

## ディレクトリ構成

```
next-sts/
├── app/
│   ├── api/
│   │   └── session/
│   │       └── route.ts   # Ephemeral Token 発行 API Route
│   ├── page.tsx           # メイン UI（WebRTC 接続・波形・トランスクリプト）
│   ├── layout.tsx
│   └── globals.css
├── env.local.example
├── next.config.ts
├── package.json
└── README.md
```

## 環境変数一覧

| 変数名 | 説明 | 必須 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API キー（`sk-...`） | ✅ |

## 動作確認済み環境

- Node.js 20+
- Next.js 15 (App Router)
- OpenAI `gpt-realtime` モデル（GA版）

## セッション設定

`app/api/session/route.ts` で以下を構成しています：

| 項目 | 値 | 目的 |
|---|---|---|
| `model` | `gpt-realtime` | GA版・非Reasoning（コスト効率重視） |
| `audio.input.turn_detection` | `semantic_vad` | 雑音や残響での誤発火を抑制 |
| `audio.input.transcription.model` | `whisper-1` | ユーザー発話の文字起こし |
| `instructions` | 日本語の丁寧語強制 / 勝手な話題禁止 | 不要な独白を抑制 |

## クライアント側の音声処理

`app/page.tsx` の WebRTC 音声まわりで以下を実施：

- **エコーキャンセル / ノイズ抑制 / オートゲイン** : `getUserMedia` で明示的に有効化（AIの声をマイクが拾うフィードバック防止）
- **音量ブースト** : WebAudio `GainNode` で 1.2 倍に増幅（HTML `<audio>` は 1.0 が上限のため）
- **波形ビジュアライザ** : `AnalyserNode` で周波数データを取得して描画
- **STOP 時のクリーンアップ** : `RTCPeerConnection` / `AudioContext` / マイクトラックを完全停止

## 注意事項

- **マイク権限** : ブラウザがマイクアクセスを要求します。`https://` 上（または `localhost`）でのみ動作します。Vercel デプロイは自動で HTTPS になるので問題ありません。
- **Ephemeral Token の有効期限** : OpenAI 発行のトークンは 60 秒で失効します。接続確立後は WebRTC セッション自体が継続するため問題ありません。
- **コスト** : OpenAI Realtime API は通常の Chat API より高価です。使い終わったら必ず STOP ボタンを押してセッションを切断してください。
