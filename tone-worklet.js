// マイクの音を 2048 標本ずつ本体へ送るだけの AudioWorklet（0.4.0）。検出は本体（tone-detect.js）で行う
class ToneTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          // endFrame：この塊の最後の標本の、音の時計での番号（currentFrame はこのブロックの先頭）
          this.port.postMessage({ samples: this.buf, endFrame: currentFrame + i + 1 }, [this.buf.buffer]);
          this.buf = new Float32Array(2048); this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('tone-tap', ToneTap);
