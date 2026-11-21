/**
 * WebSocket 客户端（协议 v1）。
 *
 * - 同源 /ws，可用 VITE_WS_URL 覆盖（绝对 ws(s):// 或路径）。
 * - welcome 后持久化 playerId + token；重连先发 hello 恢复身份与所在房间。
 * - 自动重连：指数退避 0.5s → 1s → 2s → 4s → 8s → 10s（封顶）。
 * - 每 20s 发送 ping；页面卸载时关闭连接。
 * - 对外暴露 send / onMessage / status。
 */
import type { ClientMessage, ServerMessage } from '../types';
import { parseServerMessage } from './protocol';
import { clearSession, loadSession, saveSession } from './session';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'replaced';

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: SocketStatus) => void;

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
      // 站点部署在子路径（如 /gomoku）时，WS 也挂在同一前缀下
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
  private currentStatus: SocketStatus = 'connecting';
  private attempts = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private manualClose = true;
  private greeted = false;
  private hadConnection = false;
  private lastWelcome: { playerId: string; token: string } | null = null;
  private pending: ClientMessage[] = [];
  /** 本次连接是否带 session 发起 hello：等待 hello 结果后再补发排队消息。 */
  private expectingHello = false;
  private flushTimer: number | null = null;
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

  /* ------------------------------ 内部实现 ------------------------------ */

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
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.greeted = false;
    this.lastWelcome = null;

    socket.onopen = () => {
      const session = loadSession();
      this.expectingHello = session !== null;
      if (session) {
        this.rawSend({ type: 'hello', playerId: session.playerId, token: session.token });
      }
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      this.handleRawMessage(event.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.greeted = false;
      this.expectingHello = false;
      this.clearFlushTimer();
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
      this.lastWelcome = { playerId: message.playerId, token: message.token };
      // 重连握手期间先收到的是服务端新分配的匿名身份；在 hello 结果回来前不能落盘，
      // 否则握手窗口内断线会把原 session 覆盖成匿名身份、彻底丢失座位。
      if (!this.expectingHello || message.reconnected) {
        saveSession(this.lastWelcome);
      }
      this.greeted = true;
      this.setStatus('open');
      this.startPing();
      if (!this.expectingHello || message.reconnected) {
        // 没有 session，或 hello 已成功恢复身份：可以安全补发排队消息。
        this.expectingHello = false;
        this.clearFlushTimer();
        this.flushPending();
      } else {
        // 先到的是全新身份 welcome，等 hello 结果（正常情况下紧跟一条 reconnected=true）。
        this.scheduleFlushFallback();
      }
    } else if (message.type === 'error' && message.code === 'AUTH_FAILED') {
      // 服务端保持当前全新身份不变：保留本连接收到的 welcome 身份，否则清空。
      if (this.lastWelcome) {
        saveSession(this.lastWelcome);
      } else {
        clearSession();
      }
      this.expectingHello = false;
      this.clearFlushTimer();
      this.flushPending();
    }

    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  private scheduleFlushFallback(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.expectingHello = false;
      this.flushPending();
    }, 800);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
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
    this.clearFlushTimer();
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
