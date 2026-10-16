"""Fish Audio + text-driven viseme timing shared by browser preview and MP4 export.

These are *estimated* A/O/E visemes aligned to detected acoustic activity.
Fish TTS MP3 does not provide word-level timestamps via this endpoint.
"""
from __future__ import annotations
from array import array
import math
import re
import subprocess
import unicodedata
from pathlib import Path

FPS = 25
# The original Persona Studio 3.1 eight-slot order.
SLOTS = ("aClosed", "aOpen", "idleClosed", "idleOpen",
         "oClosed", "oOpen", "eClosed", "eOpen")
POSE = {"A": (0, 1), "idle": (2, 3), "O": (4, 5), "E": (6, 7)}
WORD = re.compile(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+(?:['’-][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)*")


def normalized(word: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", word.lower())
                   if unicodedata.category(c) != "Mn")


def word_gestures(word: str) -> list[str]:
    """Same A/O/E grouping as the original Persona Studio wordGestures()."""
    chunks = re.findall(r"[aeiou]+", normalized(word))
    vowels = [("A" if "a" in x else "O" if "o" in x or "u" in x else "E")
              for x in chunks]
    if not vowels:
        return ["idle"]
    main = vowels[max(0, int((len(vowels) - 1) * .55))]
    if len(normalized(word)) >= 9 and len(vowels) >= 3 and vowels[-1] != main:
        return [main, vowels[-1]]
    return [main]


def pcm_energy(audio: Path) -> tuple[list[float], float]:
    """Decode the generated MP3 itself, not microphone input or estimated duration."""
    p = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(audio),
         "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
        capture_output=True, check=True, timeout=110)
    samples = array("h")
    samples.frombytes(p.stdout[:len(p.stdout) // 2 * 2])
    if not samples:
        raise ValueError("Fish devolvió un audio sin muestras.")
    step = 320  # 40 ms = 25 frames/sec
    energy = []
    for i in range(0, len(samples), step):
        chunk = samples[i:i + step]
        energy.append(math.sqrt(sum(s * s for s in chunk) / len(chunk)))
    return energy, len(samples) / 8000


def _activity(energy: list[float]) -> list[bool]:
    if not energy:
        return []
    peak = max(energy)
    if peak <= 0:
        return [False] * len(energy)
    ordered = sorted(energy)
    noise = ordered[int(.18 * (len(ordered) - 1))]
    threshold = max(100, peak * .085, noise * 2.4)
    if peak < threshold:
        threshold = peak * .55
    active = [v > threshold for v in energy]
    # Bridge micro-gaps under 80ms (prevent flickering).
    for i in range(1, len(active) - 2):
        if active[i - 1] and active[i + 1]:
            active[i] = True
    for i in range(1, len(active) - 3):
        if active[i - 1] and active[i + 2]:
            active[i] = active[i + 1] = True
    # Keep real pauses, but suppress lone transient spikes.
    original = active[:]
    for i in range(len(active)):
        count = sum(original[max(0, i - 1): min(len(active), i + 2)])
        if count == 1:
            active[i] = False
    return active


def build_timeline(audio: Path, text: str, intensity: int = 45,
                   delay_ms: int = 0, auto_blink: bool = True) -> dict:
    """Produce a deterministic compact array [[time_in_seconds, slot_index], ...].

    Shared by browser playback (HTMLAudioElement.currentTime) and FFmpeg concat.
    """
    intensity = min(85, max(20, int(intensity)))
    delay_ms = min(160, max(-100, int(delay_ms)))
    energy, duration = pcm_energy(audio)
    active = _activity(energy)
    words = WORD.findall(text)
    weights = [max(1.0, .8 * len(re.findall(r"[aeiou]+", normalized(w))) +
                    .10 * len(w)) for w in words]
    total_weight = sum(weights)
    # Spoken-time position only advances on true vocal activity. This avoids
    # animating during pauses even when Fish speaks slower than estimated.
    ranks = []
    elapsed = 0
    for is_active in active:
        ranks.append(elapsed)
        if is_active:
            elapsed += 1
    total_voice_frames = elapsed
    word_bounds = []
    accumulated = 0.0
    if total_weight:
        for weight in weights:
            start = int(total_voice_frames * accumulated / total_weight)
            accumulated += weight
            end = max(start + 1, int(total_voice_frames * accumulated / total_weight))
            word_bounds.append((start, end))
    events = []
    last = None
    duration_frames = int(math.ceil(duration * FPS))
    for frame in range(duration_frames):
        shifted = frame + int(round(delay_ms / 1000 * FPS))
        if 0 <= shifted < len(active) and active[shifted] and total_voice_frames and words:
            rank = ranks[shifted]
            idx = 0
            while idx < len(word_bounds) - 1 and rank >= word_bounds[idx][1]:
                idx += 1
            begin, end = word_bounds[idx]
            age = max(0, rank - begin)
            span = max(1, end - begin)
            fraction = age / span
            gestures = word_gestures(words[idx])
            # Single readable pulse for short words. A long word may have two.
            opening = .08
            closing = .34 + .49 * (intensity / 100)
            v = "idle"
            if opening <= fraction < min(.91, closing):
                v = gestures[0]
            elif len(gestures) > 1 and .72 <= fraction < .92 and span >= 12:
                v = gestures[1]
        else:
            v = "idle"
        # Blink every ~3-5 s with deterministic timing, without opening/closing
        # the mouth independently of the voice.
        t = frame / FPS
        blink = bool(auto_blink and (
            3.15 <= t % 4.25 < 3.27 or
            (t > 10 and 1.1 <= (t + 1.7) % 11.6 < 1.22)
        ))
        key = POSE[v][0 if blink else 1]
        if key != last:
            events.append([round(t, 4), key])
            last = key
    if not events:
        events = [[0.0, POSE["idle"][1]]]
    return {
        "version": 2, "fps": FPS, "duration": round(duration, 5),
        "intensity": intensity, "delay_ms": delay_ms,
        "auto_blink": bool(auto_blink), "slot_names": list(SLOTS),
        "events": events,
        "method": "acoustic-activity+text-visemes"
    }


def event_durations(timeline: dict) -> list[tuple[int, float]]:
    events = timeline["events"]
    result = []
    for i, (t, sprite) in enumerate(events):
        next_t = events[i + 1][0] if i + 1 < len(events) else timeline["duration"]
        duration = max(.001, next_t - t)
        result.append((sprite, duration))
    return result
