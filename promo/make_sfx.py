"""Generate a short, original ambient bed and four restrained UI chimes for the film."""
from pathlib import Path
import wave
import numpy as np

RATE = 48_000
DURATION = 15.0
N = int(RATE * DURATION)
t = np.arange(N, dtype=np.float64) / RATE
mix = np.zeros((N, 2), dtype=np.float64)

def envelope(start: float, end: float, attack: float = 0.45, release: float = 0.65) -> np.ndarray:
    local = t - start
    length = end - start
    fade_in = np.clip(local / attack, 0, 1)
    fade_in = fade_in * fade_in * (3 - 2 * fade_in)
    fade_out = np.clip((length - local) / release, 0, 1)
    fade_out = fade_out * fade_out * (3 - 2 * fade_out)
    return fade_in * fade_out

# Soft sustained chords create a gentle lift without competing with the onscreen Hindi.
chords = [
    (0.0, 4.1, [130.81, 196.00, 261.63, 329.63]),
    (3.8, 8.1, [174.61, 261.63, 349.23, 440.00]),
    (7.8, 11.7, [146.83, 220.00, 293.66, 369.99]),
    (11.4, 15.0, [130.81, 196.00, 261.63, 392.00]),
]
for start, end, notes in chords:
    env = envelope(start, end, 0.9, 1.1)
    bed = np.zeros(N)
    for i, hz in enumerate(notes):
        phase = 2 * np.pi * hz * t + i * 0.17
        bed += (np.sin(phase) + 0.18 * np.sin(phase * 2)) / len(notes)
    bed *= env * 0.10
    mix[:, 0] += bed
    mix[:, 1] += np.roll(bed, int(RATE * 0.012)) * 0.96

# A quiet breath of air gives the bed some texture; fixed seed keeps every render identical.
rng = np.random.default_rng(17)
noise = rng.normal(0, 1, N)
# One-pole low pass, then mix low enough to read as texture, not hiss.
filtered = np.empty(N)
filtered[0] = 0
for i in range(1, N):
    filtered[i] = filtered[i - 1] + 0.035 * (noise[i] - filtered[i - 1])
ambience = filtered * envelope(0.0, DURATION, 1.2, 1.4) * 0.012
mix[:, 0] += ambience
mix[:, 1] += np.roll(ambience, 130)

# Four glassy notes mark the voice, bill result, guided form, and final brand lockup.
for start, hz in [(2.05, 659.25), (6.35, 783.99), (9.25, 880.00), (13.05, 1046.50)]:
    local = t - start
    active = (local >= 0) & (local < 1.0)
    x = np.maximum(local, 0)
    chime = np.sin(2 * np.pi * hz * x) * np.exp(-4.8 * x)
    chime += 0.22 * np.sin(2 * np.pi * hz * 2.01 * x) * np.exp(-7.0 * x)
    chime *= active * 0.095
    mix[:, 0] += chime
    mix[:, 1] += np.roll(chime, 85)

# Head/tail fades and gentle limiting keep the master comfortable.
fade = np.minimum(np.clip(t / 0.45, 0, 1), np.clip((14.1 - t) / 0.65, 0, 1))
mix *= fade[:, None]
mix = np.tanh(mix * 1.4) * 0.78
pcm = np.clip(mix * 32767, -32768, 32767).astype('<i2')
out = Path(__file__).with_name('browse-voice-15s.wav')
with wave.open(str(out), 'wb') as wav:
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(RATE)
    wav.writeframes(pcm.tobytes())
print(f'Wrote {out} ({DURATION:.1f}s, stereo {RATE} Hz)')
