/**
 * WebSocket 客户端（协议 v1）。
 *
 * - 同源 /ws，可用 VITE_WS_URL 覆盖（绝对 ws(s):// 或路径）。
 * - 身份是 localStorage 里的 UUID：首次由服务端在 welcome 中下发，
 *   之后连接时通过 ?uid=<uuid> 带回，刷新/重开浏览器都能认回同一玩家。
 * - 自动重连：指数退避 0.5s → 1s → 2s → 4s → 8s → 10s（封顶）。
 * - 每 20s 发送 ping；页面卸载时关闭连接。
 * - 对外暴露 send / onMessage / onBinary / status。
 * - 实时游戏（坦克大战）的二进制输入与快照帧走 sendBinary / onBinary，
 *   不进入 JSON 解析，也不会跨连接重放（重连后由服务端的关键帧自然恢复）。
 */
import type { ClientMessage, ServerMessage } from '../types';
import { parseServerMessage } from './protocol';
import { loadUid, saveUid } from './session';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'replaced';

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: SocketStatus) => void;
type BinaryListener = (data: ArrayBuffer) => void;

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 10000];
const PING_INTERVAL_MS = 20_000;
const MAX_PENDING = 20;

function wsProtocol(): string {
  return window.location.protocol === 'https:' ? 'wss:' : 'ws:';
}

/**
 * 解析 WebSocket 地址。优先级：
 * 1. VITE_WS_URL（wss://host/ws、/ws、host/ws 均可）；
 * 2. VITE_API_BASE 为绝对地址时，自动推导 `ws(s)://<api-host>/ws`；
 * 3. 同源 `ws(s)://<当前页面 host>/ws`（生产同域反代 / 开发 Vite 代理的默认形态）。
 */
function toWsUrl(value: string): string | null {
  // 允许误写 http(s)://：自动换成 ws(s)://；路径为空时补 /ws。
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const path =
      url.pathname && url.pathname !== '/'
        ? url.pathname.replace(/\/+$/, '')
        : '/ws';
    return `${protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

function resolveSocketUrl(configured?: string, apiBase?: string): string {
  const value = (configured ?? '').trim();
  if (value) {
    if (value.startsWith('ws://') || value.startsWith('wss://')) return value;
    const fromHttp = toWsUrl(value);
    if (fromHttp) return fromHttp;
    if (value.startsWith('/')) return `${wsProtocol()}//${window.location.host}${value}`;
    return `${wsProtocol()}//${value.replace(/^\/+/, '')}`;
  }

  const base = (apiBase ?? '').trim();
  if (/^https?:\/\//i.test(base)) {
    try {
      const apiUrl = new URL(base);
      const protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      // 站点部署在子路径（如 /games）时，WS 也挂在同一前缀下
      const prefix = apiUrl.pathname
        .replace(/\/+$/, '')
        .replace(/\/api$/i, '');
      const path = prefix && prefix !== '/' ? `${prefix}/ws` : '/ws';
      return `${protocol}//${apiUrl.host}${path}`;
    } catch {
      /* 非法 URL：退回同源 */
    }
  }

  return `${wsProtocol()}//${window.location.host}/ws`;
}

export class GameSocket {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly binaryListeners = new Set<BinaryListener>();
  private currentStatus: SocketStatus = 'connecting';
  private attempts = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private manualClose = true;
  private greeted = false;
  private hadConnection = false;
  private pending: ClientMessage[] = [];
  private readonly unloadHandler = (): void => {
    this.shutdown();
  };
  private readonly onlineHandler = (): void => {
    if (this.manualClose || this.socket) return;
    this.clearReconnectTimer();
    this.open();
  };

  constructor(url?: string, apiBase?: string) {
    this.url = resolveSocketUrl(url, apiBase);
  }

  /* ------------------------------ 公开 API ------------------------------ */

  connect(): void {
    if (!this.manualClose && this.socket) return;
    this.manualClose = false;
    this.attempts = 0;
    window.addEventListener('pagehide', this.unloadHandler);
    window.addEventListener('beforeunload', this.unloadHandler);
    window.addEventListener('online', this.onlineHandler);
    this.open();
  }

  disconnect(): void {
    this.shutdown();
    this.setStatus('closed');
  }

  /** 当前连接状态（对外暴露）。 */
  get status(): SocketStatus {
    return this.currentStatus;
  }

  getStatus(): SocketStatus {
    return this.currentStatus;
  }

  isConnected(): boolean {
    return (
      this.currentStatus === 'open' &&
      this.socket !== null &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** 订阅实时对局的二进制帧（快照）。 */
  onBinary(listener: BinaryListener): () => void {
    this.binaryListeners.add(listener);
    return () => {
      this.binaryListeners.delete(listener);
    };
  }

  /**
   * 发送消息。连接尚未就绪时最多缓存 20 条，welcome 后按序补发。
   * 返回 false 表示消息进入等待队列（未立即发送）。
   */
  send(message: ClientMessage): boolean {
    if (this.canSend()) {
      this.rawSend(message);
      return true;
    }
    if (this.manualClose) return false;
    if (this.pending.length >= MAX_PENDING) this.pending.shift();
    this.pending.push(message);
    return false;
  }

  /** 发送二进制帧（实时游戏输入）。连接未就绪时直接丢弃：实时输入不该排队补发。 */
  sendBinary(data: ArrayBuffer): boolean {
    if (!this.canSend() || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  /** 把已保存的 UUID 拼到 WS 地址上；没有 UUID 时交给服务端生成。 */
  private endpoint(): string {
    const uid = loadUid();
    if (!uid) return this.url;
    try {
      const url = new URL(this.url);
      url.searchParams.set('uid', uid);
      return url.toString();
    } catch {
      const separator = this.url.includes('?') ? '&' : '?';
      return `${this.url}${separator}uid=${encodeURIComponent(uid)}`;
    }
  }

  private canSend(): boolean {
    return (
      this.greeted &&
      this.socket !== null &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  private rawSend(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      /* 发送失败由 onclose 驱动重连 */
    }
  }

  private open(): void {
    if (this.manualClose) return;
    if (this.socket) return;
    this.setStatus(this.hadConnection ? 'reconnecting' : 'connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.endpoint());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    this.greeted = false;

    socket.onopen = () => {
      /* 身份已经通过 ?uid= 带在 URL 上，等 welcome 即可。 */
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === 'string') {
        this.handleRawMessage(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        for (const listener of this.binaryListeners) {
          listener(event.data);
        }
      }
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.greeted = false;
      this.stopPing();
      if (this.manualClose) {
        this.setStatus('closed');
        return;
      }
      if (event.code === 4001) {
        // 服务端明确表示身份被其它连接接管：不再自动重连，避免多标签页互相顶号死循环
        this.manualClose = true;
        this.setStatus('replaced');
        return;
      }
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      /* 浏览器随后会触发 onclose，统一在那里处理重连 */
    };
  }

  private handleRawMessage(data: string): void {
    const message = parseServerMessage(data);
    if (!message) return;

    if (message.type === 'welcome') {
      this.hadConnection = true;
      this.attempts = 0;
      // 服务端首次生成或规范化后的 UUID 立即落盘，之后重连一直使用它。
      saveUid(message.playerId);
      this.greeted = true;
      this.setStatus('open');
      this.startPing();
      this.flushPending();
    }

    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) {
      this.rawSend(message);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      if (!this.canSend()) return;
      this.rawSend({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)];
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(next: SocketStatus): void {
    if (this.currentStatus === next) return;
    this.currentStatus = next;
    for (const listener of this.statusListeners) {
      listener(next);
    }
  }

  /** 关闭连接但保留实例（可再次 connect），用于组件卸载。 */
  private shutdown(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.stopPing();
    this.pending = [];
    this.greeted = false;
    window.removeEventListener('pagehide', this.unloadHandler);
    window.removeEventListener('beforeunload', this.unloadHandler);
    window.removeEventListener('online', this.onlineHandler);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
