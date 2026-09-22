/**
 * Noise and buzzing. All synthesised — the repo ships no audio files, and a
 * party game that needs a download before it makes a sound is no fun.
 */

let ctx = null;

/** Must be called from a real user gesture or iOS keeps the context muted. */
export function unlockAudio() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function tone({ freq, to = freq, duration = 0.12, type = 'square', gain = 0.16, delay = 0 }) {
  if (!ctx || ctx.state !== 'running') return;
  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);

  // Tiny attack/release so nothing clicks.
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(amp).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

export const sfx = {
  order: () => tone({ freq: 660, duration: 0.07, type: 'triangle', gain: 0.1 }),
  good: () => {
    tone({ freq: 740, duration: 0.07, type: 'triangle' });
    tone({ freq: 1180, duration: 0.11, type: 'triangle', delay: 0.06 });
  },
  bad: () => {
    tone({ freq: 190, to: 70, duration: 0.3, type: 'sawtooth', gain: 0.2 });
  },
  tap: () => tone({ freq: 420, duration: 0.04, type: 'square', gain: 0.07 }),
  alarm: () => {
    for (let i = 0; i < 3; i++) {
      tone({ freq: 880, to: 440, duration: 0.15, type: 'sawtooth', gain: 0.18, delay: i * 0.18 });
    }
  },
  wave: () => {
    [523, 659, 784, 1046].forEach((freq, i) =>
      tone({ freq, duration: 0.16, type: 'triangle', gain: 0.14, delay: i * 0.09 }),
    );
  },
  over: () => {
    [440, 330, 247, 165].forEach((freq, i) =>
      tone({ freq, duration: 0.34, type: 'sawtooth', gain: 0.18, delay: i * 0.2 }),
    );
  },
};

/** Android only in practice; iOS Safari ignores it, which is fine. */
export function buzz(pattern) {
  navigator.vibrate?.(pattern);
}
