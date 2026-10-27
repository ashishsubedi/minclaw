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

def get_state_dir() -> Path:
    return Path(os.environ.get("MINCLAW_STATE_DIR", Path.home() / ".minclaw"))

STATE_DIR = get_state_dir()
SOCKET_PATH = STATE_DIR / "kokoro.sock"
IDLE_TIMEOUT_SECONDS = int(os.environ.get("KOKORO_IDLE_TIMEOUT", "180"))
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
DEFAULT_SIMILARITY_THRESHOLD = float(os.environ.get("MINCLAW_SPEAKER_THRESHOLD", "0.65"))

def cosine_similarity(u, v) -> float:
    if not u or not v or len(u) != len(v):
        return 0.0
    dot = sum(a * b for a, b in zip(u, v))
    return float(dot)

class SpeakerVerifier:
    def __init__(self):
        self._sherpa_extractor = None
        self._sherpa_checked = False

    @property
    def voiceprint_path(self) -> Path:
        return get_state_dir() / "owner_voiceprint.json"

    def _init_sherpa(self):
        if self._sherpa_checked:
            return self._sherpa_extractor
        self._sherpa_checked = True
        try:
            import sherpa_onnx
            model_path = os.environ.get("MINCLAW_SPEAKER_MODEL")
            if model_path and os.path.exists(model_path):
                config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                    model=model_path,
                    num_threads=2,
                    debug=False,
                    provider="cpu",
                )
                self._sherpa_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
                print(f"[speaker] Loaded sherpa_onnx extractor from {model_path}", flush=True)
        except Exception:
            self._sherpa_extractor = None
        return self._sherpa_extractor

    def extract_embedding(self, audio_path: str):
        # 1. Try sherpa-onnx if configured
        sherpa = self._init_sherpa()
        if sherpa:
            try:
                import soundfile as sf
                audio, sample_rate = sf.read(audio_path, dtype="float32")
                if len(audio.shape) > 1:
                    audio = audio.mean(axis=1)
                stream = sherpa.create_stream()
                stream.accept_waveform(sample_rate, audio)
                stream.input_finished()
                emb = list(sherpa.compute(stream))
                norm = sum(x * x for x in emb) ** 0.5
                if norm > 0:
                    emb = [x / norm for x in emb]
                return emb
            except Exception as e:
                print(f"[speaker] sherpa_onnx extraction failed: {e}", flush=True)

        # 2. Try torchaudio / torch
        try:
            import torch
            import torchaudio
            waveform, sample_rate = torchaudio.load(audio_path)
            if waveform.ndim == 1:
                waveform = waveform.unsqueeze(0)
            if waveform.shape[0] > 1:
                waveform = torch.mean(waveform, dim=0, keepdim=True)
            if sample_rate != 16000:
                resampler = torchaudio.transforms.Resample(sample_rate, 16000)
                waveform = resampler(waveform)

            # 30-dim MFCC extraction
            mfcc_transform = torchaudio.transforms.MFCC(
                sample_rate=16000,
                n_mfcc=30,
                melkwargs={"n_fft": 400, "hop_length": 160, "n_mels": 40}
            )
            mfcc = mfcc_transform(waveform).squeeze(0)
            if mfcc.ndim == 1:
                mfcc = mfcc.unsqueeze(1)
            mean = torch.mean(mfcc, dim=1)
            std = torch.std(mfcc, dim=1)
            p25 = torch.quantile(mfcc, 0.25, dim=1)
            p75 = torch.quantile(mfcc, 0.75, dim=1)
            emb = torch.cat([mean, std, p25, p75])
            emb = torch.nn.functional.normalize(emb, p=2, dim=0)
            return emb.cpu().numpy().tolist()
        except Exception:
            pass

        # 3. Fallback using numpy & wave
        try:
            import numpy as np
            import wave
            with wave.open(audio_path, 'rb') as wf:
                n_channels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                sample_rate = wf.getframerate()
                n_frames = wf.getnframes()
                data = wf.readframes(n_frames)

            if sampwidth == 2:
                samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
            else:
                samples = np.frombuffer(data, dtype=np.float32)

            if n_channels > 1:
                samples = samples.reshape(-1, n_channels).mean(axis=1)

            frame_len = 400
            hop_len = 160
            if len(samples) < frame_len:
                samples = np.pad(samples, (0, frame_len - len(samples)))

            num_frames = max(1, (len(samples) - frame_len) // hop_len)
            frames = np.lib.stride_tricks.sliding_window_view(samples[:num_frames * hop_len + frame_len], frame_len)[::hop_len]
            window = np.hanning(frame_len)
            spec = np.abs(np.fft.rfft(frames * window, axis=1))

            mean = np.mean(spec, axis=0)
            std = np.std(spec, axis=0)
            p25 = np.percentile(spec, 25, axis=0)
            p75 = np.percentile(spec, 75, axis=0)
            emb = np.concatenate([mean, std, p25, p75])
            norm = np.linalg.norm(emb)
            if norm > 0:
                emb = emb / norm
            return emb.tolist()
        except Exception as e:
            print(f"[speaker] Acoustic fallback failed: {e}", flush=True)
            return None

    def enroll_speaker(self, audio_paths: list, threshold: float = DEFAULT_SIMILARITY_THRESHOLD) -> dict:
        if not audio_paths:
            return {"status": "error", "message": "No audio paths provided"}

        embeddings = []
        for path in audio_paths:
            if not os.path.exists(path):
                return {"status": "error", "message": f"Audio file not found: {path}"}
            emb = self.extract_embedding(path)
            if emb is None:
                return {"status": "error", "message": f"Failed to extract embedding from {path}"}
            embeddings.append(emb)

        dim = len(embeddings[0])
        centroid = [0.0] * dim
        for emb in embeddings:
            for i in range(dim):
                centroid[i] += emb[i]
        for i in range(dim):
            centroid[i] /= len(embeddings)

        norm = sum(x * x for x in centroid) ** 0.5
        if norm > 0:
            centroid = [x / norm for x in centroid]

        data = {
            "enrolled_at": time.time(),
            "samples_count": len(audio_paths),
            "threshold": float(threshold),
            "embedding": centroid
        }

        self.voiceprint_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.voiceprint_path, "w") as f:
            json.dump(data, f, indent=2)
        os.chmod(self.voiceprint_path, 0o600)

        print(f"[speaker] ✅ Enrolled {len(audio_paths)} samples to {self.voiceprint_path} (0600)", flush=True)
        return {"status": "ok", "samples_enrolled": len(audio_paths)}

    def verify_speaker(self, audio_path: str, threshold: float = None) -> dict:
        if not self.voiceprint_path.exists():
            return {
                "status": "ok",
                "enrolled": False,
                "verified": True,
                "reason": "unenrolled"
            }

        if not os.path.exists(audio_path):
            return {"status": "error", "message": f"Audio file not found: {audio_path}"}

        try:
            with open(self.voiceprint_path, "r") as f:
                vp = json.load(f)
        except Exception as e:
            return {"status": "error", "message": f"Failed to read voiceprint: {e}"}

        centroid = vp.get("embedding")
        if not centroid:
            return {"status": "error", "message": "Corrupt voiceprint file"}

        target_threshold = float(threshold) if threshold is not None else float(vp.get("threshold", DEFAULT_SIMILARITY_THRESHOLD))

        emb = self.extract_embedding(audio_path)
        if emb is None:
            return {"status": "error", "message": "Failed to extract embedding from audio"}

        score = cosine_similarity(emb, centroid)
        verified = bool(score >= target_threshold)
        return {
            "status": "ok",
            "enrolled": True,
            "verified": verified,
            "score": round(score, 4)
        }

    def voiceprint_status(self) -> dict:
        if not self.voiceprint_path.exists():
            return {
                "status": "ok",
                "enrolled": False,
                "samples_count": 0,
                "enrolled_at": 0.0
            }
        try:
            with open(self.voiceprint_path, "r") as f:
                vp = json.load(f)
            return {
                "status": "ok",
                "enrolled": True,
                "samples_count": vp.get("samples_count", 0),
                "enrolled_at": vp.get("enrolled_at", 0.0),
                "threshold": vp.get("threshold", DEFAULT_SIMILARITY_THRESHOLD)
            }
        except Exception:
            return {
                "status": "ok",
                "enrolled": False,
                "samples_count": 0,
                "enrolled_at": 0.0
            }

    def reset_voiceprint(self) -> dict:
        if self.voiceprint_path.exists():
            try:
                self.voiceprint_path.unlink()
            except Exception:
                pass
        return {"status": "ok", "message": "voiceprint removed"}

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

def handle_client(conn, engine: KokoroEngine, verifier: SpeakerVerifier):
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
        elif action == "verify_speaker":
            audio_path = req.get("audio_path", "")
            thresh = req.get("threshold")
            resp = verifier.verify_speaker(audio_path, threshold=thresh)
        elif action == "enroll_speaker":
            audio_paths = req.get("audio_paths", [])
            thresh = req.get("threshold", DEFAULT_SIMILARITY_THRESHOLD)
            resp = verifier.enroll_speaker(audio_paths, threshold=thresh)
        elif action == "voiceprint_status":
            resp = verifier.voiceprint_status()
        elif action == "reset_voiceprint":
            resp = verifier.reset_voiceprint()
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
    state_dir = get_state_dir()
    state_dir.mkdir(parents=True, exist_ok=True)
    socket_path = state_dir / "kokoro.sock"

    if socket_path.exists():
        try:
            test_s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            test_s.connect(str(socket_path))
            test_s.close()
            print(f"[kokoro] Kokoro server is already running on {socket_path}", flush=True)
            sys.exit(0)
        except Exception:
            try:
                socket_path.unlink()
            except Exception:
                pass

    engine = KokoroEngine(idle_timeout=IDLE_TIMEOUT_SECONDS, preload=False)
    verifier = SpeakerVerifier()

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path))
    server.listen(10)
    os.chmod(str(socket_path), 0o600)

    print(f"[kokoro] 🚀 Kokoro TTS IPC Server listening on {socket_path}", flush=True)
    print(f"[kokoro] ⚙️ Voice: '{DEFAULT_VOICE}', Idle memory timeout: {IDLE_TIMEOUT_SECONDS}s", flush=True)

    def shutdown(signum, frame):
        print("\n[kokoro] Shutting down...", flush=True)
        try:
            if socket_path.exists():
                socket_path.unlink()
        except:
            pass
        os._exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while True:
        try:
            conn, _ = server.accept()
            client_thread = threading.Thread(target=handle_client, args=(conn, engine, verifier), daemon=True)
            client_thread.start()
        except Exception as e:
            if not socket_path.exists():
                break
            print(f"[kokoro] Accept error: {e}", flush=True)

if __name__ == "__main__":
    main()
