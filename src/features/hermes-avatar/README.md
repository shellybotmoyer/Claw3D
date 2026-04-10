# HermesAvatar — Embeddable AI Avatar Component

A self-contained, embeddable VRM avatar component that connects to the Hermes/Honcho backend
for real-time AI conversations with facial expressions, lip sync, and gestures.

## Architecture

```
HermesAvatar (the widget)
├── AvatarStage (3D canvas + camera + lights)
│   └── AvatarSpeechScene (VRM model + lip sync + expressions)
├── ChatPanel (text input + message history)
├── HermesBridge (connects to backend API)
└── ExpressionMapper (maps LLM sentiment → avatar expressions + gestures)
```

## Embedding

### React (Next.js / React Native Web)

```tsx
import { HermesAvatar } from "@/features/hermes-avatar";

<HermesAvatar
  modelUrl="/avatars/Avatar_Orion.vrm"
  apiBaseUrl="/api/hermes"
  personaName="Phil"
/>
```

### iframe (Any framework, mobile, desktop)

```html
<iframe src="/avatar-widget" style="width:400px;height:600px" />
<!-- Parent control via postMessage -->
<iframe.contentWindow.postMessage({
  source: 'xlunar-avatar',
  command: { type: 'expression', id: 'happy' }
}, '*');
```

### Web Component (Vanilla JS)

```html
<hermes-avatar
  model-url="/avatars/Avatar_Orion.vrm"
  api-base-url="/api/hermes"
  persona-name="Phil"
></hermes-avatar>
```

## Features

- **VRM avatars**: Load any VRM model (v0.x, v1.0, VRoid GLB)
- **Speech-driven lip sync**: Audio amplitude drives mouth animation
- **15+ facial expressions**: happy, sad, angry, surprised, thinking, etc.
- **8 poses + gestures**: idle, relaxed, waving, pointing, thinking, etc.
- **Motion sequences**: choreographed pose+expression combos
- **VRMA animations**: Full-body animation clips
- **TTS integration**: OpenAI or ElevenLabs for voice synthesis
- **Chat streaming**: Real-time LLM responses with expression mapping
- **PostMessage bridge**: Control from any parent window/iframe
- **Web Component wrapper**: Use in vanilla JS without React

## API

The HermesAvatar connects to the backend via:

- `POST /api/hermes/chat` — Send message, get streaming response
- `POST /api/hermes/tts` — Text-to-speech synthesis
- `GET /api/hermes/state` — Get agent state (for expression mapping)

Backend routes are proxied through Next.js API routes to keep API keys server-side.