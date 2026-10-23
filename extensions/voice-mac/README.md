# MinClaw Voice Extension (`voice-mac`)

A Whispr Flow-style push-to-talk voice companion for MinClaw on macOS.

## Features

- **Push-to-Talk Hold UX**: Hold **Right Option** (or **Fn**) to talk. Release to send.
- **Auditory Cues**: Subtle system earcons on key press (`Tink`) and key release (`Pop`).
- **Barge-in / Interruption**: Pressing the key while MinClaw is speaking instantly stops audio playback.
- **Two UI Modes**:
  - `notch` (Default): Camera notch aura glow + dynamic soundwave wings, dropping down smoothly into conversation history.
  - `bottom`: Whispr Flow-style floating pill with reactive waveform and expandable conversation card.
- **Multi-Turn Conversation History**: Retains the last 3–5 turns with user speech bubbles and assistant responses. Auto-fades after 15s of inactivity.
- **Resource-Guarded Kokoro TTS (`af_heart`)**:
  - Studio-quality 24kHz voice output.
  - **45s Auto-Idle Memory Guard**: Unloads model weights and empties Metal/MPS cache after 45s of inactivity, dropping idle footprint to < 35 MB.
- **Local Metal STT**: Apple Silicon accelerated transcription via `mlx_whisper` (~200ms latency, 100% private and offline).
- **Decoupled Architecture**: Connects to MinClaw daemon via `~/.minclaw/daemon.sock` using standard NDJSON protocol.

## Usage

```bash
# Build the native binary
cd extensions/voice-mac && make

# Start in default Notch mode (Hold Right Option)
./bin/minclaw-voice

# Start in Bottom Pill mode
./bin/minclaw-voice --mode bottom

# Use Fn / Globe key instead of Right Option
./bin/minclaw-voice --hotkey fn
```

Or via MinClaw CLI:
```bash
minclaw voice          # Starts the voice extension in background
minclaw voice status   # Checks extension status
minclaw voice stop     # Stops voice extension
```

## Permissions Required

On first run, macOS will prompt for:
1. **Microphone**: Needed by `AVAudioRecorder` to capture your voice.
2. **Accessibility**: Needed to capture the global push-to-talk modifier key even when another app is focused.
