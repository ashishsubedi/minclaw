#!/usr/bin/env python3
"""
Kokoro TTS Resource-Guarded IPC Server.
Listens on a Unix socket (~/.minclaw/kokoro.sock).
Lazy-loads Kokoro pipeline with language routing (English 'a', Nepali/Hindi 'h')
and unloads when idle to reclaim RAM / Metal MPS memory on Apple Silicon.
"""

import os
import sys
import json
import time
import socket
import signal
import gc
import threading
import warnings
from pathlib import Path

# Suppress PyTorch weight norm / dropout deprecation warnings
warnings.filterwarnings("ignore")

STATE_DIR = Path(os.environ.get("MINCLAW_STATE_DIR", Path.home() / ".minclaw"))
SOCKET_PATH = STATE_DIR / "kokoro.sock"
IDLE_TIMEOUT_SECONDS = int(os.environ.get("KOKORO_IDLE_TIMEOUT", "180"))
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")

class KokoroEngine:
    def __init__(self, idle_timeout: int = IDLE_TIMEOUT_SECONDS, preload: bool = True):
        self.idle_timeout = idle_timeout
        self.pipelines = {}
        self.lock = threading.Lock()
        self.idle_timer = None
        self.torch = None
        self.sf = None
        if preload:
            threading.Thread(target=self._ensure_loaded, args=("a",), daemon=True).start()

    def _ensure_loaded(self, lang_code: str = "a"):
        with self.lock:
            # Cancel idle timer if active
            if self.idle_timer:
                self.idle_timer.cancel()
                self.idle_timer = None

            if lang_code not in self.pipelines or self.pipelines[lang_code] is None:
                print(f"[kokoro] ⏳ Loading Kokoro-82M pipeline for lang '{lang_code}'...", flush=True)
                start_t = time.time()
                import torch
                import soundfile as sf
                from kokoro import KPipeline

                self.torch = torch
                self.sf = sf
                self.pipelines[lang_code] = KPipeline(lang_code=lang_code, repo_id='hexgrad/Kokoro-82M')
                elapsed = time.time() - start_t
                print(f"[kokoro] ✅ Model loaded ('{lang_code}') in {elapsed:.2f}s", flush=True)

    def _schedule_unload(self):
        with self.lock:
            if self.idle_timer:
                self.idle_timer.cancel()
            self.idle_timer = threading.Timer(self.idle_timeout, self._unload_model)
            self.idle_timer.daemon = True
            self.idle_timer.start()

    def _unload_model(self):
        with self.lock:
            if self.pipelines:
                print(f"[kokoro] 💤 Inactivity timeout ({self.idle_timeout}s reached). Unloading models to reclaim memory...", flush=True)
                self.pipelines.clear()
                gc.collect()
                if self.torch and self.torch.backends.mps.is_available():
                    self.torch.mps.empty_cache()
                print("[kokoro] 🍃 Memory reclaimed. Process is idle (< 40MB).", flush=True)
            self.idle_timer = None

    def synthesize(self, text: str, output_path: str, voice: str = DEFAULT_VOICE, speed: float = 1.0, lang: str = "en") -> dict:
        start_t = time.time()
        text = text.strip()
        if not text:
            return {"status": "error", "message": "Empty text provided"}

        # Strip all emoji and pictorial characters so Kokoro never speaks emoji names
        import re
        emoji_pattern = re.compile(
            r"[\U00010000-\U0010ffff\u2600-\u27bf\ufe00-\ufe0f\u200d\u2300-\u23ff]",
            flags=re.UNICODE
        )
        text = emoji_pattern.sub("", text).strip()
        if not text:
            return {"status": "error", "message": "Text contained only emojis"}

        # Language filtering & parameter resolution (English & Nepali supported)
        lang_str = str(lang).lower().strip() if lang else "en"
        has_devanagari = any('\u0900' <= char <= '\u097f' for char in text)

        if lang_str in ("ne", "nepali", "hi", "hindi", "h") or has_devanagari:
            lang_code = "h"
            target_voice = "hf_alpha" if (not voice or voice == DEFAULT_VOICE or not voice.startswith("h")) else voice
        else:
            lang_code = "a"
            target_voice = DEFAULT_VOICE if (not voice or voice.startswith("h")) else voice

        self._ensure_loaded(lang_code)
        pipeline = self.pipelines.get(lang_code)
        if pipeline is None:
            return {"status": "error", "message": f"Pipeline for {lang_code} could not be initialized"}

        try:
            generator = pipeline(text, voice=target_voice, speed=speed)
            all_audio = []
            sample_rate = 24000

            for _, _, audio in generator:
                all_audio.append(audio)

            if not all_audio:
                return {"status": "error", "message": "No audio generated"}

            import numpy as np
            combined_audio = np.concatenate(all_audio) if len(all_audio) > 1 else all_audio[0]
            self.sf.write(output_path, combined_audio, sample_rate)

            duration = len(combined_audio) / float(sample_rate)
            elapsed = time.time() - start_t
            rtf = elapsed / duration if duration > 0 else 0

            print(f"[kokoro] 🔊 Synthesized ({lang_code}/{target_voice}) {duration:.2f}s audio in {elapsed:.2f}s (RTF: {rtf:.2f}) -> {output_path}", flush=True)
            return {
                "status": "ok",
                "output_path": output_path,
                "duration": duration,
                "elapsed": elapsed,
                "lang_code": lang_code,
                "voice": target_voice
            }
        except Exception as e:
            print(f"[kokoro] Synthesis error: {e}", flush=True)
            return {"status": "error", "message": str(e)}
        finally:
            self._schedule_unload()

def handle_client(conn, engine: KokoroEngine):
    try:
        data = conn.recv(65536)
        if not data:
            return
        line = data.decode("utf-8").strip()
        if not line:
            return

        req = json.loads(line)
        action = req.get("action", "synthesize")

        if action == "ping":
            resp = {"status": "ok", "loaded": bool(engine.pipelines)}
        elif action == "warmup":
            threading.Thread(target=engine._ensure_loaded, args=("a",), daemon=True).start()
            resp = {"status": "ok", "loaded": bool(engine.pipelines)}
        elif action == "unload":
            engine._unload_model()
            resp = {"status": "ok", "message": "unloaded"}
        elif action == "synthesize":
            text = req.get("text", "")
            out = req.get("output_path", f"/tmp/kokoro_{int(time.time()*1000)}.wav")
            voice = req.get("voice", DEFAULT_VOICE)
            speed = float(req.get("speed", 1.0))
            lang = req.get("lang") or req.get("language") or req.get("lang_code") or "en"
            resp = engine.synthesize(text=text, output_path=out, voice=voice, speed=speed, lang=lang)
        else:
            resp = {"status": "error", "message": f"Unknown action: {action}"}

        conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
    except Exception as err:
        try:
            err_resp = {"status": "error", "message": str(err)}
            conn.sendall((json.dumps(err_resp) + "\n").encode("utf-8"))
        except:
            pass
    finally:
        try:
            conn.close()
        except:
            pass

def main():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if SOCKET_PATH.exists():
        try:
            test_s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            test_s.connect(str(SOCKET_PATH))
            test_s.close()
            print(f"[kokoro] Kokoro server is already running on {SOCKET_PATH}", flush=True)
            sys.exit(0)
        except Exception:
            try:
                SOCKET_PATH.unlink()
            except Exception:
                pass

    engine = KokoroEngine(idle_timeout=IDLE_TIMEOUT_SECONDS, preload=True)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(SOCKET_PATH))
    server.listen(10)
    os.chmod(str(SOCKET_PATH), 0o600)

    print(f"[kokoro] 🚀 Kokoro TTS IPC Server listening on {SOCKET_PATH}", flush=True)
    print(f"[kokoro] ⚙️ Voice: '{DEFAULT_VOICE}', Idle memory timeout: {IDLE_TIMEOUT_SECONDS}s", flush=True)

    def shutdown(signum, frame):
        print("\n[kokoro] Shutting down...", flush=True)
        try:
            if SOCKET_PATH.exists():
                SOCKET_PATH.unlink()
        except:
            pass
        os._exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while True:
        try:
            conn, _ = server.accept()
            client_thread = threading.Thread(target=handle_client, args=(conn, engine), daemon=True)
            client_thread.start()
        except Exception as e:
            if not SOCKET_PATH.exists():
                break
            print(f"[kokoro] Accept error: {e}", flush=True)

if __name__ == "__main__":
    main()
