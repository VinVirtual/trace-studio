"""trace-studio narration: Kokoro voice for each scene, then a mix with a quiet pad under it.

usage:  python narrate.py voice <story.json> <workdir>     one WAV per scene + voice.json (lengths, word times)
        python narrate.py mix <timeline.json> <workdir>    mix.wav: the scene WAVs placed on the timeline

Run it with the Python that has kokoro-onnx (default ~/kokoro/.venv/bin/python).
env:    KOKORO_HOME (default ~/kokoro), KOKORO_MODEL, KOKORO_VOICES
"""
import hashlib, json, os, re, sys
from pathlib import Path

RATE = 24000


def fail(msg):
    sys.exit("narrate: " + msg)


def load_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"file not found: {path}")
    except json.JSONDecodeError as e:
        fail(f"{path} is not valid JSON: {e}")


def safe_id(s):
    if not isinstance(s, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", s):
        fail(f"scene id {s!r} may only use letters, digits, '_' and '-'")
    return s


def syllables(word):
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 1
    n = len(re.findall(r"[aeiouy]+", w))
    if w.endswith("e") and n > 1 and not w.endswith("le"):
        n -= 1
    return max(1, n)


def voice(story_path, work):
    story = load_json(story_path)
    scenes = story.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        fail("the story has no scenes")
    try:
        import numpy as np
        import soundfile as sf
        from kokoro_onnx import Kokoro
    except ImportError as e:
        fail(f"{e}. Install into this Python: pip install kokoro-onnx soundfile numpy")
    home = Path(os.environ.get("KOKORO_HOME") or Path.home() / "kokoro")
    model = Path(os.environ.get("KOKORO_MODEL") or home / "kokoro-v1.0.onnx")
    voices = Path(os.environ.get("KOKORO_VOICES") or home / "voices-v1.0.bin")
    for f in (model, voices):
        if not f.is_file():
            fail(f"Kokoro model file not found: {f} (see README.md, Requirements)")
    name = story.get("voice") or "af_heart"
    speed = story.get("speed") or 1
    if not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2:
        fail("speed must be a number from 0.5 to 2")
    cache = work / ".voice-cache"
    cache.mkdir(parents=True, exist_ok=True)
    kokoro = None
    out = []
    for sc in scenes:
        sid = safe_id(sc.get("id"))
        text = str(sc.get("say") or "").strip()
        if not text:
            fail(f"scene {sid} has nothing to say")
        key = hashlib.sha256(json.dumps([text, name, speed, model.name]).encode()).hexdigest()[:24]
        hit = cache / f"{key}.npy"
        if hit.is_file():
            audio = np.load(hit)
        else:
            if kokoro is None:
                kokoro = Kokoro(str(model), str(voices))
            try:
                audio, _ = kokoro.create(text, voice=name, speed=speed, lang="en-us")
            except Exception as e:  # an unknown voice name, mostly
                fail(f"Kokoro could not speak scene {sid} with voice {name!r}: {e}")
            audio = np.asarray(audio, dtype=np.float32)
            np.save(hit, audio)
        # cut silence at both ends, keep a few milliseconds
        level = np.convolve(np.abs(audio), np.ones(240) / 240, "same")
        loud = np.where(level > 0.008)[0]
        if len(loud):
            pad = int(0.03 * RATE)
            audio = audio[max(0, loud[0] - pad):min(len(audio), loud[-1] + pad)]
        sf.write(work / f"{sid}.wav", audio, RATE)
        dur = len(audio) / RATE
        words = text.split()
        weights = [syllables(w) + (1.5 if re.search(r"[.,;:!?]$", w) else 0) for w in words]
        total = sum(weights)
        t, times = 0.0, []
        for w, wt in zip(words, weights):
            times.append({"w": w, "t": round(t / total * dur * 0.97, 3)})
            t += wt
        out.append({"id": sid, "dur": round(dur, 3), "words": times})
        print(f"voice  {sid:10s} {dur:5.2f}s  {len(words)} words")
    (work / "voice.json").write_text(json.dumps({"rate": RATE, "voice": name, "scenes": out}, indent=1), encoding="utf-8")


def mix(timeline_path, work):
    import numpy as np
    import soundfile as sf
    tl = load_json(timeline_path)
    total = float(tl["total"])
    n = int(total * RATE) + 1
    t = np.arange(n) / RATE
    speech = np.zeros(n, np.float32)
    for sc in tl["scenes"]:
        f = work / f"{safe_id(sc['id'])}.wav"
        if not f.is_file():
            continue
        x, rate = sf.read(f, dtype="float32")
        if rate != RATE:
            fail(f"{f} has sample rate {rate}, expected {RATE}")
        s = int(sc["voiceAt"] * RATE)
        e = min(n, s + len(x))
        speech[s:e] += x[: e - s]
    # a quiet pad: two slow chords (A minor, F major), each note a sine with a soft second partial
    chords = [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63]]
    pad = np.zeros(n, np.float32)
    bar = 8.0
    for i, start in enumerate(np.arange(0, total, bar)):
        a, b = int(start * RATE), min(n, int((start + bar + 1.0) * RATE))
        tt = t[a:b] - start
        env = np.minimum(1, tt / 1.5) * np.minimum(1, np.maximum(0, (bar + 1.0 - tt) / 1.5))
        tone = sum(np.sin(2 * np.pi * f * tt) + 0.25 * np.sin(4 * np.pi * f * tt) for f in chords[i % 2])
        pad[a:b] += (tone * env * 0.018).astype(np.float32)
    # a soft tick at each scene change
    for sc in tl["scenes"][1:]:
        s = int(sc["start"] * RATE)
        d = int(0.05 * RATE)
        if s + d < n:
            tt = np.arange(d) / RATE
            pad[s:s + d] += (np.sin(2 * np.pi * 1400 * tt) * np.exp(-tt * 90) * 0.05).astype(np.float32)
    # the pad dips while someone is speaking, and fades in and out
    level = np.convolve(np.abs(speech), np.ones(int(0.15 * RATE)) / (0.15 * RATE), "same")
    duck = 1 - 0.6 * np.clip(level / 0.04, 0, 1)
    fade = np.clip(np.minimum(t / 0.8, (total - t) / 1.5), 0, 1)
    out = speech + pad * duck * fade
    peak = float(np.max(np.abs(out))) or 1.0
    out = out / max(1.0, peak / 0.95)
    sf.write(work / "mix.wav", out.astype(np.float32), RATE)
    print(f"mix    {total:.2f}s -> {work / 'mix.wav'}")


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("voice", "mix"):
        fail("usage: narrate.py voice <story.json> <workdir> | narrate.py mix <timeline.json> <workdir>")
    work = Path(sys.argv[3]).resolve()
    work.mkdir(parents=True, exist_ok=True)
    (voice if sys.argv[1] == "voice" else mix)(Path(sys.argv[2]), work)
