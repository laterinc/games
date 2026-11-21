/**
 * 把 WebSocket 消息收敛为 React 状态（房间、大厅列表、聊天、toast），
 * 并暴露带校验的发送动作。组件只依赖这里的类型与动作。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  ChatMessage,
  ChatPayload,
  ClientMessage,
  CreateColor,
  CreateRoomPayload,
  JoinRoomPayload,
  QuickMatchPayload,
  Room,
  RoomSummary,
  RoomVisibility,
  ServerMessage,
  ToastItem,
  ToastLevel,
} from '../types';
import { fetchRoomList } from '../lib/api';
import {
  ERROR_CODE_LABEL,
  MAX_CHAT_LENGTH,
  MAX_NICKNAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
} from '../lib/protocol';
import { GameSocket, type SocketStatus } from '../lib/socket';

export interface GameSocketState {
  status: SocketStatus;
  playerId: string | null;
  room: Room | null;
  rooms: RoomSummary[];
  chat: ChatMessage[];
  toasts: ToastItem[];
}

const initialState: GameSocketState = {
  status: 'connecting',
  playerId: null,
  room: null,
  rooms: [],
  chat: [],
  toasts: [],
};

type ReducerAction =
  | { type: 'status'; status: SocketStatus }
  | { type: 'welcome'; playerId: string }
  | { type: 'room'; room: Room | null }
  | { type: 'rooms'; rooms: RoomSummary[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'toast'; id: number; level: ToastLevel; text: string }
  | { type: 'dismissToast'; id: number };

const MAX_CHAT_HISTORY = 200;
const MAX_TOASTS = 4;

function reducer(state: GameSocketState, action: ReducerAction): GameSocketState {
  switch (action.type) {
    case 'status':
      return state.status === action.status ? state : { ...state, status: action.status };
    case 'welcome':
      return state.playerId === action.playerId ? state : { ...state, playerId: action.playerId };
    case 'room': {
      if (!action.room) return { ...state, room: null, chat: [] };
      const snapshotChat = action.room.chat;
      return {
        ...state,
        room: action.room,
        chat: snapshotChat ? snapshotChat : state.chat,
      };
    }
    case 'rooms':
      return { ...state, rooms: action.rooms };
    case 'chat': {
      if (state.chat.some((item) => item.id === action.message.id)) return state;
      return { ...state, chat: [...state.chat, action.message].slice(-MAX_CHAT_HISTORY) };
    }
    case 'toast':
      return {
        ...state,
        toasts: [...state.toasts, { id: action.id, level: action.level, text: action.text }].slice(
          -MAX_TOASTS,
        ),
      };
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
    default:
      return state;
  }
}

export interface GameActions {
  createRoom: (options: {
    name: string;
    roomName: string;
    visibility: RoomVisibility;
    color: CreateColor;
  }) => void;
  joinRoom: (roomId: string, name: string) => void;
  quickMatch: (name: string) => void;
  refreshRooms: () => void;
  ready: () => void;
  move: (row: number, col: number) => void;
  rematch: () => void;
  leaveRoom: () => void;
  chat: (text: string) => void;
  notify: (text: string, level?: ToastLevel) => void;
  dismissToast: (id: number) => void;
}

export interface UseGameSocketResult {
  state: GameSocketState;
  actions: GameActions;
}

function isValidNickname(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_NICKNAME_LENGTH;
}

function isValidRoomCode(code: string): boolean {
  return /^[A-Za-z0-9]{6}$/.test(code);
}

export function useGameSocket(): UseGameSocketResult {
  const socketRef = useRef<GameSocket | null>(null);
  if (socketRef.current === null) {
    socketRef.current = new GameSocket(
      import.meta.env.VITE_WS_URL,
      import.meta.env.VITE_API_BASE,
    );
  }

  const [state, dispatch] = useReducer(reducer, initialState);
  const toastSeqRef = useRef(0);
  const toastTimersRef = useRef<Map<number, number>>(new Map());

  const send = useCallback((message: ClientMessage): boolean => {
    return socketRef.current?.send(message) ?? false;
  }, []);

  const pushToast = useCallback((level: ToastLevel, text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    toastSeqRef.current += 1;
    dispatch({ type: 'toast', id: toastSeqRef.current, level, text: trimmed });
  }, []);

  const dismissToast = useCallback((id: number): void => {
    const timer = toastTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    dispatch({ type: 'dismissToast', id });
  }, []);

  const notify = useCallback(
    (text: string, level: ToastLevel = 'info'): void => {
      pushToast(level, text);
    },
    [pushToast],
  );

  /* ------------------------------ 连接生命周期 ------------------------------ */

  const handleServerMessage = useCallback(
    (message: ServerMessage): void => {
      switch (message.type) {
        case 'welcome':
          dispatch({ type: 'welcome', playerId: message.playerId });
          break;
        case 'room':
          dispatch({ type: 'room', room: message.room });
          break;
        case 'rooms':
          dispatch({ type: 'rooms', rooms: message.rooms });
          break;
        case 'chat':
          dispatch({ type: 'chat', message: message.message });
          break;
        case 'notice':
          pushToast(message.level, message.text);
          break;
        case 'error':
          pushToast('error', message.message || ERROR_CODE_LABEL[message.code] || '操作失败');
          break;
        case 'pong':
          break;
        default:
          break;
      }
    },
    [pushToast],
  );

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return undefined;
    dispatch({ type: 'status', status: socket.getStatus() });
    const offStatus = socket.onStatus((status) => dispatch({ type: 'status', status }));
    const offMessage = socket.onMessage(handleServerMessage);
    socket.connect();
    return () => {
      offMessage();
      offStatus();
      socket.disconnect();
    };
  }, [handleServerMessage]);

  // 大厅内保持房间列表新鲜：连接后立即拉一次，之后每 10s 拉一次（rooms 推送是主通道）。
  const inRoom = state.room !== null;
  useEffect(() => {
    if (state.status !== 'open' || inRoom) return undefined;
    send({ type: 'list_rooms' });
    const timer = window.setInterval(() => {
      send({ type: 'list_rooms' });
    }, 10_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [state.status, inRoom, send]);

  // toast 自动消失（每个 toast 独立计时）。
  useEffect(() => {
    const timers = toastTimersRef.current;
    for (const toast of state.toasts) {
      if (timers.has(toast.id)) continue;
      const timer = window.setTimeout(() => {
        timers.delete(toast.id);
        dispatch({ type: 'dismissToast', id: toast.id });
      }, 4200);
      timers.set(toast.id, timer);
    }
    for (const [id, timer] of timers) {
      if (!state.toasts.some((toast) => toast.id === id)) {
        window.clearTimeout(timer);
        timers.delete(id);
      }
    }
  }, [state.toasts]);

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /* ------------------------------ 发送动作 ------------------------------ */

  const actions = useMemo<GameActions>(() => {
    const createRoom = (options: {
      name: string;
      roomName: string;
      visibility: RoomVisibility;
      color: CreateColor;
    }): void => {
      const name = options.name.trim();
      if (!isValidNickname(name)) {
        pushToast('error', `昵称需为 1–${MAX_NICKNAME_LENGTH} 个字符`);
        return;
      }
      const roomName = options.roomName.trim();
      if (roomName.length > MAX_ROOM_NAME_LENGTH) {
        pushToast('error', `房间名最多 ${MAX_ROOM_NAME_LENGTH} 个字符`);
        return;
      }
      const payload: CreateRoomPayload = {
        type: 'create_room',
        name,
        visibility: options.visibility,
        color: options.color,
      };
      if (roomName) payload.roomName = roomName;
      send(payload);
    };

    const joinRoom = (roomId: string, name: string): void => {
      const code = roomId.trim().toUpperCase();
      if (!isValidRoomCode(code)) {
        pushToast('error', '请输入 6 位房间码');
        return;
      }
      const trimmedName = name.trim();
      if (!isValidNickname(trimmedName)) {
        pushToast('error', `昵称需为 1–${MAX_NICKNAME_LENGTH} 个字符`);
        return;
      }
      const payload: JoinRoomPayload = { type: 'join_room', roomId: code, name: trimmedName };
      send(payload);
    };

    const quickMatch = (name: string): void => {
      const trimmedName = name.trim();
      if (!isValidNickname(trimmedName)) {
        pushToast('error', `昵称需为 1–${MAX_NICKNAME_LENGTH} 个字符`);
        return;
      }
      const payload: QuickMatchPayload = { type: 'quick_match', name: trimmedName };
      send(payload);
    };

    const refreshRooms = (): void => {
      const socket = socketRef.current;
      if (socket?.isConnected()) {
        send({ type: 'list_rooms' });
        return;
      }
      fetchRoomList()
        .then((rooms) => {
          dispatch({ type: 'rooms', rooms });
        })
        .catch((error: unknown) => {
          const text = error instanceof Error ? error.message : '房间列表刷新失败';
          pushToast('error', text);
        });
    };

    const ready = (): void => {
      send({ type: 'ready' });
    };

    const move = (row: number, col: number): void => {
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return;
      send({ type: 'move', row, col });
    };

    const rematch = (): void => {
      send({ type: 'rematch' });
    };

    const leaveRoom = (): void => {
      send({ type: 'leave_room' });
    };

    const chat = (text: string): void => {
      const trimmed = text.trim();
      if (trimmed.length < 1 || trimmed.length > MAX_CHAT_LENGTH) {
        pushToast('error', `聊天内容需为 1–${MAX_CHAT_LENGTH} 个字符`);
        return;
      }
      const payload: ChatPayload = { type: 'chat', text: trimmed };
      send(payload);
    };

    return {
      createRoom,
      joinRoom,
      quickMatch,
      refreshRooms,
      ready,
      move,
      rematch,
      leaveRoom,
      chat,
      notify,
      dismissToast,
    };
  }, [send, pushToast, notify, dismissToast]);

  return { state, actions };
}
