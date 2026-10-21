// AudioWorklet: raccoglie i campioni del microfono in blocchi da 1024 e li passa al thread principale.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(1024);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture", CaptureProcessor);
