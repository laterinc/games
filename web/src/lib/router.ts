/**
 * 轻量路径路由：不引入 react-router，按部署 base 解析 /{game} 与 /{game}/room/{code}。
 * 旧版 ?game=&room= 链接仍可解析，App 首帧会把它替换成规范路径。
 */
import { useEffect, useState } from 'react';
import type { GameType } from '../types';
import { gameFromSlug, gameSlug } from '../games/registry';

/** 去掉首尾斜杠的部署 base：根部署为 ''，子路径部署为 '/games'。 */
const BASE_PATH = `/${(import.meta.env.BASE_URL || '/').replace(/^\/+|\/+$/g, '')}`.replace(
  /^\/$/,
  '',
);

const NAVIGATE_EVENT = 'app:navigate';

export type AppRoute =
  | { name: 'home' }
  | { name: 'lobby'; game: GameType }
  | { name: 'room'; game: GameType | null; roomCode: string };

const ROOM_CODE_LENGTH = 6;

export function normalizeRoomCode(value: string): string {
  const code = value
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH)
    .toUpperCase();
  return code.length === ROOM_CODE_LENGTH ? code : '';
}

function stripBase(pathname: string): string {
  if (!BASE_PATH) return pathname;
  if (pathname === BASE_PATH) return '/';
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  return pathname;
}

/** 把当前 URL（含旧版 query）解析成路由；无法识别的路径回落到默认大厅。 */
export function parseRoute(
  pathname: string = window.location.pathname,
  search: string = window.location.search,
): AppRoute {
  const segments = stripBase(pathname)
    .split('/')
    .filter(Boolean);
  const params = new URLSearchParams(search);
  const legacyGame = gameFromSlug(params.get('game') ?? '');
  const legacyCode = normalizeRoomCode(params.get('room') ?? '');

  if (segments.length === 0) {
    if (legacyCode) return { name: 'room', game: legacyGame, roomCode: legacyCode };
    if (legacyGame) return { name: 'lobby', game: legacyGame };
    return { name: 'home' };
  }

  const game = gameFromSlug(segments[0]);
  if (game) {
    if (segments.length === 1) return { name: 'lobby', game };
    if (segments.length === 3 && segments[1] === 'room') {
      const roomCode = normalizeRoomCode(segments[2]);
      if (roomCode) return { name: 'room', game, roomCode };
    }
  }

  // /room/{code}：还不知道是哪个游戏，等服务端房间快照回来再规范化。
  if (segments[0] === 'room') {
    const roomCode = normalizeRoomCode(segments[1] ?? '');
    if (roomCode) return { name: 'room', game: null, roomCode };
  }

  if (legacyCode) return { name: 'room', game: legacyGame, roomCode: legacyCode };
  if (legacyGame) return { name: 'lobby', game: legacyGame };
  return { name: 'home' };
}

export function homePath(): string {
  return `${BASE_PATH}/`;
}

export function lobbyPath(game: GameType): string {
  return `${BASE_PATH}/${gameSlug(game)}`;
}

export function roomPath(game: GameType | null, roomCode: string): string {
  return game
    ? `${BASE_PATH}/${gameSlug(game)}/room/${roomCode}`
    : `${BASE_PATH}/room/${roomCode}`;
}

/** 用 History API 导航并触发 useRoute 重渲染。 */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === to) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function useRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute());

  useEffect(() => {
    const sync = (): void => setRoute(parseRoute());
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);

  return route;
}
