"""Original quiet sound bed and UI chimes for the 30-second Browse Voice concept."""
from pathlib import Path
import wave
import numpy as np

RATE = 48_000
DURATION = 36.0
N = int(RATE * DURATION)
t = np.arange(N, dtype=np.float64) / RATE
mix = np.zeros((N, 2), dtype=np.float64)

def env(a, b, attack=.8, release=1.0):
    x=t-a; length=b-a
    fi=np.clip(x/attack,0,1); fi=fi*fi*(3-2*fi)
    fo=np.clip((length-x)/release,0,1); fo=fo*fo*(3-2*fo)
    return fi*fo

# The problem opening stays quiet; the harmony enters with the helper.
for a,b,notes in [
    (7.4,13.0,[130.81,196.00,261.63,329.63]),
    (12.5,19.2,[146.83,220.00,293.66,369.99]),
    (18.7,25.0,[164.81,246.94,329.63,392.00]),
    (24.5,29.8,[130.81,196.00,261.63,392.00]),
]:
    e=env(a,b,1.2,1.4); bed=np.zeros(N)
    for i,hz in enumerate(notes):
        ph=2*np.pi*hz*t+i*.17
        bed+=(np.sin(ph)+.12*np.sin(ph*2))/len(notes)
    bed*=e*.075
    mix[:,0]+=bed;mix[:,1]+=np.roll(bed,int(RATE*.012))*.96

# Glassy, short UI notes mark the voice, answer, result and wrap-up.
for start,hz in [(8.25,659.25),(12.45,783.99),(18.25,880.0),(33.0,1046.5)]:
    local=t-start;active=(local>=0)&(local<1.1);x=np.maximum(local,0)
    ch=np.sin(2*np.pi*hz*x)*np.exp(-4.3*x)+.2*np.sin(2*np.pi*hz*2*x)*np.exp(-6*x)
    ch*=active*.07;mix[:,0]+=ch;mix[:,1]+=np.roll(ch,70)

# Give the last brand card a natural fade and enough quiet for the final line.
fade=np.minimum(np.clip((t-7.2)/.8,0,1),np.clip((36-t)/3.8,0,1))
mix*=fade[:,None]
mix=np.tanh(mix*1.35)*.78
pcm=np.clip(mix*32767,-32768,32767).astype('<i2')
out=Path(__file__).with_name('browse-voice-36s.wav')
with wave.open(str(out),'wb') as wav:
    wav.setnchannels(2);wav.setsampwidth(2);wav.setframerate(RATE);wav.writeframes(pcm.tobytes())
print(f'Wrote {out} ({DURATION:.1f}s, stereo {RATE} Hz)')
