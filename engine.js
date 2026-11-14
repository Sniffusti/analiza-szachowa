// Wspólny interfejs UCI dla natywnych silników (przez WebSocket do server.js)
// oraz Stockfisha WASM uruchamianego w przeglądarce (Web Worker).

let socket = null;
let socketReady = null;
const channels = new Map(); // ch -> Engine

function connectSocket() {
  if (socketReady) return socketReady;
  socketReady = new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/engine`);
    socket.onopen = () => resolve(socket);
    socket.onerror = (e) => { socketReady = null; reject(e); };
    socket.onclose = () => { socketReady = null; for (const e of channels.values()) e._onExit(); };
    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const eng = channels.get(msg.ch);
      if (!eng) return;
      if (msg.line) eng._onLine(msg.line);
      if (msg.error) eng._onError(msg.error);
      if (msg.exited) eng._onExit();
    };
  });
  return socketReady;
}

export const WASM_ID = 'wasm';

export class Engine {
  constructor(ch) {
    this.ch = ch;
    this.engineId = null;
    this.worker = null;
    this.gen = 0;
    this.running = false;
    this.idle = Promise.resolve();
    this._resolveIdle = null;
    this.current = null; // {gen, fen, lines, resolve, onUpdate}
    this.multipv = 1;
    this.onError = null;
    channels.set(ch, this);
  }

  async setEngine(id) {
    if (id === this.engineId) return;
    await this.stop();
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.engineId = id;
    this.multipv = 1;
    this.running = false;
    if (id === WASM_ID) {
      this.worker = new Worker('vendor/stockfish/stockfish-19-lite-single.js');
      this.worker.onmessage = (e) => this._onLine(String(e.data));
      this._send('uci');
      this._send('setoption name Hash value 64');
    } else {
      await connectSocket();
      this._send('isready');
    }
  }

  _send(line) {
    if (this.engineId === WASM_ID) this.worker?.postMessage(line);
    else if (socket && socket.readyState === 1) socket.send(JSON.stringify({ ch: this.ch, engine: this.engineId, line }));
  }

  _onError(err) {
    this.onError?.(err);
    this._finish(null);
  }
  _onExit() { this._finish(null); }

  _finish(bestmove) {
    const cur = this.current;
    this.running = false;
    this.current = null;
    if (this._resolveIdle) { this._resolveIdle(); this._resolveIdle = null; }
    if (cur) cur.resolve(cur.gen === this.gen ? { lines: cur.lines.filter(Boolean), bestmove } : null);
  }

  _onLine(line) {
    const cur = this.current;
    if (line.startsWith('bestmove')) {
      const bm = line.split(/\s+/)[1];
      this._finish(bm && bm !== '(none)' ? bm : null);
      return;
    }
    if (!cur || !line.startsWith('info ') || !line.includes(' pv ') || !line.includes(' score ')) return;
    if (line.includes('lowerbound') || line.includes('upperbound')) return;
    const t = line.split(/\s+/);
    const info = { multipv: 1, depth: 0, cp: null, mate: null, pv: [], nodes: 0, nps: 0 };
    for (let i = 1; i < t.length; i++) {
      const k = t[i];
      if (k === 'depth') info.depth = +t[++i];
      else if (k === 'multipv') info.multipv = +t[++i];
      else if (k === 'nodes') info.nodes = +t[++i];
      else if (k === 'nps') info.nps = +t[++i];
      else if (k === 'score') {
        const typ = t[++i], v = +t[++i];
        if (typ === 'cp') info.cp = v; else info.mate = v;
      } else if (k === 'pv') { info.pv = t.slice(i + 1); break; }
    }
    // zamiana na perspektywę białych
    const sign = cur.fen.split(' ')[1] === 'w' ? 1 : -1;
    if (info.cp !== null) info.cp *= sign;
    if (info.mate !== null) info.mate = info.mate === 0 ? 0 : info.mate * sign;
    cur.lines[info.multipv - 1] = info;
    if (cur.gen === this.gen) cur.onUpdate?.(cur.lines.filter(Boolean));
  }

  /** Analiza pozycji. Zwraca {lines, bestmove} albo null, gdy przerwana przez nowsze zlecenie. */
  async analyse(fen, opts = {}, onUpdate) {
    const gen = ++this.gen;
    if (this.running) { this._send('stop'); await this.idle; }
    if (gen !== this.gen) return null;
    const multipv = opts.multipv || 1;
    if (multipv !== this.multipv) { this._send(`setoption name MultiPV value ${multipv}`); this.multipv = multipv; }
    this.running = true;
    this.idle = new Promise((r) => (this._resolveIdle = r));
    return new Promise((resolve) => {
      this.current = { gen, fen, lines: [], resolve, onUpdate };
      this._send(`position fen ${fen}`);
      let go = 'go';
      if (opts.depth) go += ` depth ${opts.depth}`;
      if (opts.nodes) go += ` nodes ${opts.nodes}`;
      if (opts.movetime) go += ` movetime ${opts.movetime}`;
      if (!opts.depth && !opts.nodes && !opts.movetime) go += ' infinite';
      this._send(go);
    });
  }

  async stop() {
    this.gen++;
    if (this.running) { this._send('stop'); await this.idle; }
  }
}

export async function listEngines() {
  const list = [];
  try {
    const r = await fetch('/api/engines');
    if (r.ok) list.push(...(await r.json()));
  } catch {}
  list.push({ id: WASM_ID, name: 'Stockfish 19 lite (przeglądarka, WASM)' });
  return list;
}
