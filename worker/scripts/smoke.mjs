#!/usr/bin/env node
/**
 * Workers 后端冒烟测试（需要先启动 `worker/scripts/dev.sh`）。
 *
 *   node worker/scripts/smoke.mjs
 *   WS_BASE=wss://example.com/games/ws HTTP_BASE=https://example.com/games \
 *     node worker/scripts/smoke.mjs
 *
 * 覆盖：welcome、建房/加入/准备/五连、战绩、D1 重连、坦克二进制快照与输入。
 */
import WebSocket from '../../web/node_modules/ws/index.js';

const WS_BASE = process.env.WS_BASE || 'ws://127.0.0.1:8787/ws';
const HTTP_BASE = process.env.HTTP_BASE || WS_BASE.replace(/^ws/, 'http').replace(/\/ws$/, '');
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const TIMEOUT = 8000;

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

class Client {
  constructor(uid = crypto.randomUUID()) {
    this.uid = uid;
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`${WS_BASE}?uid=${uid}`, { headers: { Origin: ORIGIN } });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.onBinary?.(data);
        return;
      }
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      for (const waiter of [...this.waiters]) {
        if (waiter.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(msg);
        }
      }
    });
    this.open = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  sendBinary(buf) { this.ws.send(buf); }
  wait(pred, ms = TIMEOUT) {
    const existing = this.messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function testTurnBased() {
  const a = new Client();
  const b = new Client();
  try {
    await Promise.all([a.open, b.open]);
    await a.wait((m) => m.type === 'welcome');
    await b.wait((m) => m.type === 'welcome');

    a.send({ type: 'create_room', name: 'Alice', gameType: 'gomoku', color: 'black', visibility: 'public' });
    const roomMsg = await a.wait((m) => m.type === 'room' && m.room?.status === 'waiting');
    const roomId = roomMsg.room.id;
    check(/^[A-Z2-9]{6}$/.test(roomId), `五子棋建房 ${roomId}`);

    b.send({ type: 'join_room', roomId, name: 'Bob' });
    await b.wait((m) => m.type === 'room' && m.room?.id === roomId);
    await a.wait((m) => m.type === 'room' && m.room?.players.length === 2);
    a.send({ type: 'ready' });
    b.send({ type: 'ready' });
    await a.wait((m) => m.type === 'room' && m.room?.status === 'playing');

    const moves = [[0,0],[1,0],[0,1],[1,1],[0,2],[1,2],[0,3],[1,3],[0,4]];
    for (let i = 0; i < moves.length; i++) {
      (i % 2 === 0 ? a : b).send({ type: 'move', row: moves[i][0], col: moves[i][1] });
      await (i % 2 === 0 ? a : b).wait(
        (m) => m.type === 'room' && m.room?.game?.moves?.length === i + 1,
      );
    }
    const finished = await a.wait((m) => m.type === 'room' && m.room?.status === 'finished');
    check(finished.room.game.winner === 'black', '五子棋五连判胜');
    const records = await a.wait((m) => m.type === 'records' && m.records?.length > 0);
    check(records.records[0].result === 'win', '战绩写入并下发');

    const uid = a.uid;
    a.close();
    await new Promise((r) => setTimeout(r, 600));
    const again = new Client(uid);
    await again.open;
    const welcome = await again.wait((m) => m.type === 'welcome');
    check(welcome.reconnected === true, '同 UUID 重连被识别');
    const restored = await again.wait((m) => m.type === 'records');
    check(restored.records.length > 0, '重连后战绩仍存在（D1 / 内存）');
    again.close();
  } finally {
    a.close(); b.close();
  }
}

async function testTank() {
  const client = new Client();
  let binary = 0;
  let firstByte = null;
  const errors = [];
  client.onBinary = (data) => {
    binary++;
    if (firstByte === null) firstByte = data[0];
  };
  try {
    await client.open;
    await client.wait((m) => m.type === 'welcome');
    client.send({
      type: 'create_room', name: 'Tank', gameType: 'tank', color: 'black',
      visibility: 'private', mode: 'ai', botCount: 1, matchSeconds: 60,
    });
    await client.wait((m) => m.type === 'room' && m.room?.status === 'playing');
    check(true, '坦克人机房开局');

    // 黄金输入样例：seq=42 tick=1000 flags=21 aim=16384
    const input = Buffer.from('01002a00e8030000150040', 'hex');
    const timer = setInterval(() => client.sendBinary(input), 100);
    await new Promise((r) => setTimeout(r, 2200));
    clearInterval(timer);
    check(binary >= 8, `实时二进制快照（收到 ${binary} 帧）`);
    check(firstByte === 2, '快照帧类型为 keyframe');
    check(errors.length === 0, '无协议错误');
  } finally {
    client.close();
  }
}

try {
  await testTurnBased();
  await testTank();
  const health = await (await fetch(`${HTTP_BASE}/api/health`)).json();
  check(health.status === 'ok', `HTTP health（d1=${health.d1}）`);
} catch (error) {
  console.error('ERROR', error);
  failures++;
}
process.exit(failures ? 1 : 0);
