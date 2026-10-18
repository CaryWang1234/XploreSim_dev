// Sampling by time makes export idempotent: importing and exporting an already sampled replay
// must not halve its temporal resolution again. Always retain both endpoints.
export function sampleReplay(frames, intervalSec = 0.2) {
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) throw new RangeError('Replay interval must be positive');
  if (frames.length < 2) return frames.slice();
  const sampled = [frames[0]];
  for (let i = 1; i < frames.length - 1; i++) {
    if (frames[i].t - sampled[sampled.length - 1].t >= intervalSec - 1e-6) sampled.push(frames[i]);
  }
  sampled.push(frames[frames.length - 1]);
  return sampled;
}
