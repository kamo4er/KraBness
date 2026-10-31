"""KraBness: голос на ПК. Слово-активатор -> команда до паузы -> Whisper (видеокарта) -> Диспетчер -> ответ вслух (Piper).

Запускает хаб (apps/hub/src/voice.ts): uv run --project voice python voice/main.py --hub http://127.0.0.1:7420
Строки «STATE <состояние>» в stdout хаб читает и показывает в настройках. Звук до слова-активатора никуда не уходит и не пишется.
"""
import argparse
import io
import json
import os
import queue
import re
import sys
import threading
import time
import urllib.request
import wave
from collections import deque
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
MODELS = HERE / "models"
RATE = 16000
FRAME = 1280  # 80 мс — столько ждёт openWakeWord


def log(msg: str) -> None:
    print(msg, flush=True)


def state(s: str) -> None:
    log(f"STATE {s}")


class FeedEnd(Exception):
    """Проверка из файла (--feed): звук кончился."""


def rms(frame: np.ndarray) -> float:
    return float(np.sqrt(np.mean((frame.astype(np.float32) / 32768) ** 2)))


def split_wake(text: str, word: str) -> tuple[bool, str]:
    """Фраза начинается со слова-активатора (можно «эй, …»; окончание любое: краб, крабик, крабок)?
    Возвращает (да/нет, команда после слова). Слово в середине фразы — не обращение."""
    stem = re.escape(word.lower().replace("ё", "е")[:4])
    m = re.match(rf"^\W*(?:(?:эй|ну|слушай|алло)\W+)?{stem}\w{{0,3}}\b\W*", text.lower().replace("ё", "е"))
    if not m:
        return False, ""
    return True, text[m.end():].strip()


def add_cuda_dlls() -> None:
    """cuBLAS и cuDNN из pip-пакетов nvidia-* — CTranslate2 ищет их DLL в PATH."""
    import importlib.util

    for pkg in ("nvidia.cublas", "nvidia.cudnn"):
        spec = importlib.util.find_spec(pkg)
        if not spec or not spec.submodule_search_locations:
            continue
        bin_dir = Path(list(spec.submodule_search_locations)[0]) / "bin"
        if bin_dir.is_dir():
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


class Hub:
    """REST хаба на localhost (доверенный, без токена)."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        # хаб на localhost — мимо любых системных прокси
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"content-type": "application/json"} if data else {})
        with self.opener.open(req, timeout=30) as r:
            return json.loads(r.read().decode() or "null")

    def dispatcher(self) -> str:
        return self.call("POST", "/api/dispatcher", {})["id"]

    def ask(self, text: str) -> tuple[str, int]:
        sid = self.dispatcher()
        seq = self.call("GET", f"/api/sessions/{sid}")["lastSeq"]
        self.call("POST", f"/api/sessions/{sid}/prompt", {"text": text})
        return sid, seq

    def reply(self, sid: str, after: int, timeout: float = 900) -> str:
        """Ждёт конца хода и возвращает, что прочитать вслух."""
        started = time.time()
        busy_seen = False
        while time.time() - started < timeout:
            r = self.call("GET", f"/api/sessions/{sid}/reply?after={after}")
            if r["status"] in ("busy", "retry"):
                busy_seen = True
            elif busy_seen or time.time() - started > 20:
                return r["speak"]
            time.sleep(1)
        return ""


class Voice:
    def __init__(self, args):
        self.args = args
        self.hub = Hub(args.hub)
        self.frames: "queue.Queue[np.ndarray]" = queue.Queue()
        self.speaking = threading.Event()
        self.workers: list[threading.Thread] = []
        # готовая английская модель openWakeWord (--oww hey_jarvis) — иначе своё слово через Whisper
        self.oww = bool(args.oww)

    # ---------- модели ----------

    def load(self) -> None:
        state("loading")
        if self.oww:
            import openwakeword
            from openwakeword.model import Model

            openwakeword.utils.download_models([self.args.oww])
            self.wake = Model(wakeword_models=[self.args.oww], inference_framework="onnx")

        from piper import PiperVoice
        from piper.download_voices import download_voice

        MODELS.mkdir(exist_ok=True)
        path = MODELS / f"{self.args.voice}.onnx"
        if not path.exists():
            download_voice(self.args.voice, MODELS)
        self.tts = PiperVoice.load(str(path))

        add_cuda_dlls()
        from faster_whisper import WhisperModel

        try:
            self.stt = WhisperModel(self.args.whisper, device="cuda", compute_type="float16", download_root=str(MODELS / "whisper"))
        except Exception as e:  # нет видеокарты/драйвера — медленнее, но работает
            log(f"whisper on cuda failed ({e}), using cpu")
            self.stt = WhisperModel(self.args.whisper, device="cpu", compute_type="int8", download_root=str(MODELS / "whisper"))
        # прогрев: на новой видеокарте первый прогон компилирует ядра (до ~30 с)
        list(self.stt.transcribe(np.zeros(RATE, dtype=np.float32), language=self.args.lang)[0])

    # ---------- звук ----------

    def tone(self, freq: float = 880, dur: float = 0.12) -> None:
        if self.args.mute:
            return
        import sounddevice as sd

        t = np.linspace(0, dur, int(22050 * dur), False)
        sd.play((np.sin(2 * np.pi * freq * t) * 0.25 * np.hanning(len(t))).astype(np.float32), 22050, blocking=True)

    def say(self, text: str) -> None:
        if not text.strip():
            return
        if self.args.mute:
            return log(f"SAY {text}")
        import sounddevice as sd

        self.speaking.set()
        try:
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                self.tts.synthesize_wav(text, w)
            buf.seek(0)
            with wave.open(buf, "rb") as w:
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
                sd.play(pcm, w.getframerate(), blocking=True)
        finally:
            # хвост эха не должен разбудить активатор
            time.sleep(0.3)
            self.speaking.clear()

    def on_audio(self, indata, _frames, _time, status) -> None:
        if status:
            log(f"mic: {status}")
        self.frames.put(indata[:, 0].copy())

    def next_frame(self) -> np.ndarray:
        if self.args.feed:
            # проверка из файла: кончился — выходим из любого ожидания
            try:
                return self.frames.get_nowait()
            except queue.Empty:
                raise FeedEnd from None
        return self.frames.get()

    # ---------- цикл ----------

    def record_command(self) -> np.ndarray | None:
        """После активатора: до паузы ~1 с, не дольше max_sec; тишина 5 с — отмена."""
        chunks: list[np.ndarray] = []
        heard = False
        silent = 0.0
        started = time.time()
        while time.time() - started < self.args.max_sec:
            f = self.next_frame()
            chunks.append(f)
            rms = float(np.sqrt(np.mean((f.astype(np.float32) / 32768) ** 2)))
            if rms > self.args.speech_rms:
                heard, silent = True, 0.0
            else:
                silent += FRAME / RATE
            if heard and silent > self.args.pause:
                break
            if not heard and silent > 5:
                return None
        return np.concatenate(chunks).astype(np.float32) / 32768 if heard else None

    def transcribe(self, audio: np.ndarray, hotwords: str | None = None) -> str:
        segs, _ = self.stt.transcribe(audio, language=self.args.lang, beam_size=1, vad_filter=True, hotwords=hotwords)
        # шум, который Whisper всё же «расслышал», отбрасываем
        return " ".join(s.text.strip() for s in segs if s.no_speech_prob < 0.6).strip()

    def next_utterance(self) -> np.ndarray | None:
        """Фраза целиком: от громкого кадра (с запасом 0,5 с до него) до паузы. None — пока говорил сам сервис."""
        pre: deque[np.ndarray] = deque(maxlen=6)
        while True:
            f = self.next_frame()
            if self.speaking.is_set():
                pre.clear()
                continue
            pre.append(f)
            if rms(f) > self.args.speech_rms:
                break
        chunks = list(pre)
        silent = 0.0
        started = time.time()
        while time.time() - started < self.args.max_sec:
            f = self.next_frame()
            chunks.append(f)
            silent = 0.0 if rms(f) > self.args.speech_rms else silent + FRAME / RATE
            if silent > self.args.wake_pause:
                break
        return np.concatenate(chunks).astype(np.float32) / 32768

    def wait_whisper_wake(self) -> str | None:
        """Слово-активатор через Whisper: фраза начинается с «Крабик» → команда после него ('' — команды не было)."""
        audio = self.next_utterance()
        if audio is None or len(audio) < RATE * 0.3:
            return None
        text = self.transcribe(audio, hotwords=self.args.wake.capitalize())
        matched, rest = split_wake(text, self.args.wake)
        if not matched:
            return None
        log(f"wake: {text}")
        return rest

    def handle(self, text: str) -> None:
        try:
            state("thinking")
            sid, seq = self.hub.ask(text)
            speak = self.hub.reply(sid, seq)
            state("speaking")
            self.say(speak or "Готово.")
        except Exception as e:
            log(f"hub: {e}")
            self.say("Хаб не отвечает.")
        finally:
            state("listening")

    def run(self) -> None:
        import sounddevice as sd

        self.load()
        if self.args.feed:
            # проверка без микрофона: звук из файла 16 кГц, потом 3 с тишины
            with wave.open(self.args.feed, "rb") as w:
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            for i in range(0, len(pcm) - FRAME, FRAME):
                self.frames.put(pcm[i : i + FRAME])
            for _ in range(int(3 * RATE / FRAME)):
                self.frames.put(np.zeros(FRAME, dtype=np.int16))
            mic = None
        else:
            mic = sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=FRAME, callback=self.on_audio, device=self.args.device)
            mic.start()
        try:
            state("listening")
            log(f"ready: say “{(self.args.oww or self.args.wake).replace('_', ' ')}”")
            while True:
                if self.oww:
                    f = self.next_frame()
                    if self.speaking.is_set():
                        continue
                    score = self.wake.predict(f).get(self.args.oww, 0.0)
                    if score < self.args.threshold:
                        continue
                    log(f"wake {score:.2f}")
                    self.wake.reset()
                    text = ""
                else:
                    said = self.wait_whisper_wake()
                    if said is None:
                        continue
                    text = said
                if not text:
                    # одно слово-активатор: сигнал и ждём команду
                    state("recording")
                    self.tone()
                    audio = self.record_command()
                    if audio is None:
                        state("listening")
                        continue
                    text = self.transcribe(audio)
                log(f"heard: {text}")
                if not text:
                    state("listening")
                    continue
                th = threading.Thread(target=self.handle, args=(text,), daemon=True)
                self.workers.append(th)
                th.start()
        except FeedEnd:
            # файл кончился: дождаться ответов и выйти
            for th in self.workers:
                th.join()
        finally:
            if mic:
                mic.stop()
                mic.close()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--hub", default="http://127.0.0.1:7420")
    p.add_argument("--wake", default="крабик", help="своё слово-активатор (ловит Whisper, только в начале фразы)")
    p.add_argument("--oww", default="", help="вместо своего слова — готовая модель openWakeWord, например hey_jarvis")
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--voice", default="ru_RU-irina-medium")
    p.add_argument("--whisper", default="large-v3-turbo")
    p.add_argument("--lang", default="ru")
    p.add_argument("--device", default=None, help="микрофон (номер или часть имени); по умолчанию системный")
    p.add_argument("--speech-rms", dest="speech_rms", type=float, default=0.015)
    p.add_argument("--pause", type=float, default=1.0)
    p.add_argument("--wake-pause", dest="wake_pause", type=float, default=0.7, help="пауза, после которой фраза считается законченной")
    p.add_argument("--max-sec", dest="max_sec", type=float, default=20)
    p.add_argument("--list-devices", action="store_true")
    p.add_argument("--feed", help="проверка: WAV 16 кГц моно вместо микрофона")
    p.add_argument("--mute", action="store_true", help="не играть звук, писать SAY <текст>")
    args = p.parse_args()
    if args.list_devices:
        import sounddevice as sd

        print(sd.query_devices())
        return
    if args.device and args.device.isdigit():
        args.device = int(args.device)
    try:
        Voice(args).run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
