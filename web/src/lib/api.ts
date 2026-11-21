/**
 * REST 兜底：WebSocket 未连接时（手动刷新大厅）通过 HTTP 拉取公开房间列表。
 * VITE_API_BASE 默认空（同源），生产与后端同端口部署时无需配置。
 */
import type { RoomSummary } from '../types';
import { parseRoomListPayload } from './protocol';

const RAW_API_BASE = import.meta.env.VITE_API_BASE ?? '';
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');

export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}

export async function fetchRoomList(signal?: AbortSignal): Promise<RoomSummary[]> {
  const response = await fetch(apiUrl('/api/rooms'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`房间列表请求失败（HTTP ${response.status}）`);
  }
  const payload: unknown = await response.json();
  return parseRoomListPayload(payload);
}
