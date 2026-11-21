/**
 * 本地持久化：重连身份（playerId + token）与昵称。
 * 身份只在收到 welcome 后写入；hello 失败（AUTH_FAILED）时清空。
 */

export interface StoredSession {
  playerId: string;
  token: string;
}

const SESSION_KEY = 'games.session.v1';
const NICKNAME_KEY = 'games.nickname.v1';

const NICKNAME_PREFIXES = ['棋友', '弈客', '棋童', '黑白君', '落子翁', '观棋人'];

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式/配额满时静默失败，不影响本轮对局 */
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function loadSession(): StoredSession | null {
  const raw = safeGet(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const playerId = record.playerId;
    const token = record.token;
    if (typeof playerId !== 'string' || !playerId) return null;
    if (typeof token !== 'string' || !token) return null;
    return { playerId, token };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  safeSet(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  safeRemove(SESSION_KEY);
}

export function loadNickname(): string {
  return (safeGet(NICKNAME_KEY) ?? '').trim();
}

export function saveNickname(nickname: string): void {
  const trimmed = nickname.trim();
  if (!trimmed) return;
  safeSet(NICKNAME_KEY, trimmed);
}

/** 生成随机中文昵称，如「棋友4217」。 */
export function randomNickname(): string {
  const prefix = NICKNAME_PREFIXES[Math.floor(Math.random() * NICKNAME_PREFIXES.length)];
  const digits = 1000 + Math.floor(Math.random() * 9000);
  return `${prefix}${digits}`;
}
