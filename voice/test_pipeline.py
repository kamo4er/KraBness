"""Сквозная проверка голоса без микрофона: фразы с «Крабик» и без (Piper) -> main.py --feed --mute
-> поддельный хаб получает команду Диспетчеру, отдаёт ответ -> main.py «говорит» его. uv run python test_pipeline.py"""
import io
import json
import subprocess
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

HERE = Path(__file__).parent
MODELS = HERE / "models"


def say(voice_name: str, text: str) -> np.ndarray:
    from piper import PiperVoice
    from piper.download_voices import download_voice

    path = MODELS / f"{voice_name}.onnx"
    if not path.exists():
        download_voice(voice_name, MODELS)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        PiperVoice.load(str(path)).synthesize_wav(text, w)
    buf.seek(0)
    with wave.open(buf, "rb") as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    return resample_poly(pcm, 16000, rate)


got: list[str] = []
calls = {"reply": 0, "since": 0}


class FakeHub(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        if self.path == "/api/dispatcher":
            return self.send({"id": "ks_d"})
        if self.path == "/api/sessions/ks_d/prompt":
            got.append(body["text"])
            calls["since"] = 0
            return self.send({})
        self.send_error(404)

    def do_GET(self):
        if self.path == "/api/sessions/ks_d":
            return self.send({"id": "ks_d", "lastSeq": 5})
        if self.path.startswith("/api/sessions/ks_d/reply?after=5"):
            calls["reply"] += 1
            calls["since"] += 1
            return self.send({"status": "busy" if calls["since"] < 3 else "idle", "lastSeq": 9, "speak": "Блокнот открыт, привет написал."})
        self.send_error(404)


def main() -> None:
    silence = lambda s: np.zeros(int(16000 * s), dtype=np.float32)
    ru = lambda t: say("ru_RU-irina-medium", t)
    # посторонняя фраза; команда одной фразой; одно слово, пауза, команда; команда с паузой 1 с посередине
    audio = np.concatenate([silence(0.5), ru("Сегодня хорошая погода, пойдём гулять."), silence(4), ru("Крабик, открой блокнот и напиши привет."), silence(4), ru("Крабик."), silence(2.0), ru("Покажи экран."), silence(4), ru("Крабик, открой телеграм"), silence(1.0), ru("и найди последнее сообщение."), silence(0.5)])
    feed = HERE / "test_feed.wav"
    with wave.open(str(feed), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(np.clip(audio, -32768, 32767).astype(np.int16).tobytes())

    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeHub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    hub = f"http://127.0.0.1:{srv.server_address[1]}"
    out = subprocess.run([sys.executable, str(HERE / "main.py"), "--hub", hub, "--feed", str(feed), "--mute"], capture_output=True, text=True, encoding="utf-8", timeout=300)
    srv.shutdown()
    log = out.stdout + out.stderr
    print(log[-1500:])
    checks = [
        ("посторонняя фраза не запустила", not any("погода" in g.lower() for g in got) and "погода" not in log.lower()),
        ("команда одной фразой", any("блокнот" in g.lower() and "привет" in g.lower() and "краб" not in g.lower() for g in got)),
        ("слово, пауза, команда", any("экран" in g.lower() and "краб" not in g.lower() for g in got)),
        ("пауза посреди фразы не порвала команду", any("телеграм" in g.lower() and "сообщение" in g.lower() for g in got)),
        ("ушло ровно три команды", len(got) == 3),
        ("дождался конца хода", calls["reply"] >= 3),
        ("ответ сказан", log.count("SAY Блокнот открыт, привет написал.") == 3),
        ("состояния", "STATE listening" in log and "STATE recording" in log and "STATE thinking" in log and "STATE speaking" in log),
    ]
    for name, ok in checks:
        print(("✓" if ok else "✗"), name)
    print("got:", got)
    sys.exit(0 if all(ok for _, ok in checks) else 1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
