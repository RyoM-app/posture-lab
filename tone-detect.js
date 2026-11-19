// 開始・終了の音の検出（0.4.0）。CVAカメラが鳴らす「純音3つの並び」（protocol.js の TONES）だけに反応する。
// 10 ms ごとに 1024 点の FFT（ハン窓）をとり、700〜4000 Hz のエネルギーのうち、目標の周波数 ±2 ビンに入る割合（純度）を求める。
// 純度が THRESH 以上の 10 ms を「その音」とし、音が [minLen, maxLen] 秒続く → 短い隙間 → 次の音 … が順番どおりに3つそろったときだけ検出する。
// 声（音声合成を含む）はエネルギーが多くの周波数に分かれるので、純度が高い状態が 0.12 秒も続かない。
// 純度の分母からは、ほかの合図の周波数（±2 ビン）を除く（部屋の残響で前の音が残っても、次の音の純度が下がらないように）。
export const DETECT = {
  fftSize: 1024, hopSec: 0.01,
  band: [700, 4000],      // 純度の分母にする帯域（Hz）
  halfWidthBins: 2,       // 目標の周波数の ±何ビンを「その音」に数えるか
  thresh: 0.6,            // 純度のしきい値
  minLen: 0.12, maxLen: 0.34,  // 1つの音の長さ（秒）。鳴らすのは 0.2 秒
  maxGap: 0.08,           // 音と音の間の隙間（秒）
  mergeLen: 0.05,         // これより短い音の切れ端は無視する（残響で前の音が一瞬だけ勝つことがある）
  minBandRms: 1e-4,       // これより小さい入力（ほぼ無音）は無視
};
// 長さ n（2のべき）の実数 FFT のパワー（簡単な基数2）
function fftPower(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const p = new Float64Array(n / 2); for (let k = 0; k < n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k]; return p;
}
export class ToneDetector {
  // patterns：{start: [1500, 2500, 1500], end: [2500, 1500, 2500]}（Hz の並び）
  constructor(sampleRate, patterns, opt = {}) {
    this.sr = sampleRate; this.o = { ...DETECT, ...opt }; this.patterns = patterns;
    this.N = this.o.fftSize; this.hop = Math.round(sampleRate * this.o.hopSec);
    this.win = Float64Array.from({ length: this.N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.N - 1)));
    this.freqs = [...new Set(Object.values(patterns).flat())];
    this.bins = Object.fromEntries(this.freqs.map(f => [f, Math.round(f * this.N / sampleRate)]));
    this.lo = Math.ceil(this.o.band[0] * this.N / sampleRate); this.hi = Math.floor(this.o.band[1] * this.N / sampleRate);
    this.buf = new Float32Array(0); this.total = 0;   // total：これまでに受け取った標本の数
    this.runs = [];      // [{f, start, end}]（start・end は標本の番号。end は最後にその音だった窓の中心）
    this.cur = null; this.lastFired = {}; this.level = 0;
  }
  // samples を加える。tEndMs は最後の標本の時刻（performance.now() の基準）。検出したら [{pattern, onsetMs, ...}] を返す
  push(samples, tEndMs) {
    const nb = new Float32Array(this.buf.length + samples.length); nb.set(this.buf); nb.set(samples, this.buf.length);
    const firstIndex = this.total - this.buf.length; this.total += samples.length;
    const toMs = k => tEndMs - (this.total - 1 - k) / this.sr * 1000;
    const out = []; let off = 0;
    while (off + this.N <= nb.length) {
      const re = new Float64Array(this.N), im = new Float64Array(this.N);
      for (let i = 0; i < this.N; i++) re[i] = nb[off + i] * this.win[i];
      const p = fftPower(re, im);
      let band = 0; for (let k = this.lo; k <= this.hi; k++) band += p[k];
      const rms = Math.sqrt(band) / this.N * 4; this.level = rms;
      let lab = null, best = 0;
      if (rms >= this.o.minBandRms) for (const f of this.freqs) {
        const near = g => { const c = this.bins[g]; let e = 0; for (let k = c - this.o.halfWidthBins; k <= c + this.o.halfWidthBins; k++) e += p[k]; return e; };
        const others = this.freqs.filter(g => g !== f).reduce((a, g) => a + near(g), 0), e = near(f);
        const purity = e / Math.max(band - others, 1e-20); if (purity >= this.o.thresh && purity > best) { best = purity; lab = f; }
      }
      const center = firstIndex + off + this.N / 2;
      this.step(lab, center, out, toMs);
      off += this.hop;
    }
    this.buf = nb.slice(off);
    return out;
  }
  step(lab, center, out, toMs) {
    const o = this.o, sr = this.sr;
    if (lab !== null && this.cur && this.cur.f === lab) this.cur.end = center;
    else {
      if (this.cur) { this.runs.push(this.cur); this.cur = null; }
      if (lab !== null) this.cur = { f: lab, start: center, end: center };
    }
    // 古い音は捨てる
    const keepFrom = center - sr * 3; this.runs = this.runs.filter(r => r.end >= keepFrom);
    if (!this.cur) return;
    const len = r => (r.end - r.start) / sr + o.hopSec;
    // 残響で前の音が一瞬だけ勝つことがあるので、mergeLen より短い音は除き、同じ音の切れ端どうしはつなぐ
    const merged = [];
    for (const r of [...this.runs, this.cur].filter(r => len(r) >= o.mergeLen)) {
      const m = merged.at(-1);
      if (m && m.f === r.f && (r.start - m.end) / sr <= o.maxGap + o.mergeLen) m.end = r.end; else merged.push({ ...r });
    }
    const last = merged.at(-1);
    // いまの音（つないだもの）が minLen に達した時点で、直前の2つと合わせて並びを調べる（同じ音について1回だけ）
    if (!last || len(last) < o.minLen || this.checkedStart === last.start) return;
    this.checkedStart = last.start;
    const seq = merged.slice(-3);
    if (seq.length < 3) return;
    for (const [name, pat] of Object.entries(this.patterns)) {
      if (!seq.every((r, i) => r.f === pat[i])) continue;
      if (!seq.slice(0, 2).every(r => len(r) >= o.minLen && len(r) <= o.maxLen)) continue;
      const gaps = [seq[1].start - seq[0].end, seq[2].start - seq[1].end].map(g => g / sr - o.hopSec);
      if (!gaps.every(g => g <= o.maxGap)) continue;
      const onsetSample = seq[0].start - this.N / 2 + this.hop;   // 最初にその音と判定した窓の始まり＋1ホップ ≒ 鳴り始め（疑似データで偏りを確かめた）
      const onsetMs = toMs(onsetSample);
      if (this.lastFired[name] !== undefined && onsetMs - this.lastFired[name] < 2000) continue;
      this.lastFired[name] = onsetMs;
      out.push({ pattern: name, onsetMs, detectedMs: toMs(center), lengths: seq.map(r => +len(r).toFixed(3)), gaps: gaps.map(g => +g.toFixed(3)) });
    }
  }
}
