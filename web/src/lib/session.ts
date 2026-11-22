/**
 * 本地持久化：浏览器身份 UUID 与昵称。
 *
 * 首次访问时由服务端生成 UUID，前端收到 welcome 后写入 localStorage 永久保存；
 * 之后每次连接都通过 WebSocket 的 ?uid=<uuid> 带回，服务端不再生成新身份。
 */

const UID_KEY = 'games.uid.v1';
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

export function loadUid(): string | null {
  const value = (safeGet(UID_KEY) ?? '').trim();
  return value || null;
}

export function saveUid(uid: string): void {
  const trimmed = uid.trim();
  if (trimmed) safeSet(UID_KEY, trimmed);
}

export function clearUid(): void {
  safeRemove(UID_KEY);
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
