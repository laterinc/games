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
  GameType,
  JoinRoomPayload,
  MoveInput,
  QuickMatchPayload,
  Room,
  MatchRecord,
  WatchRoomPayload,
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
  records: MatchRecord[];
  toasts: ToastItem[];
}

const initialState: GameSocketState = {
  status: 'connecting',
  playerId: null,
  room: null,
  rooms: [],
  chat: [],
  records: [],
  toasts: [],
};

type ReducerAction =
  | { type: 'status'; status: SocketStatus }
  | { type: 'welcome'; playerId: string }
  | { type: 'room'; room: Room | null }
  | { type: 'rooms'; rooms: RoomSummary[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'records'; records: MatchRecord[] }
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
    case 'records':
      return { ...state, records: action.records };
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
    gameType: GameType;
    roomName: string;
    visibility: RoomVisibility;
    color: CreateColor;
    boardSize?: number;
    matchSeconds?: number;
  }) => void;
  joinRoom: (roomId: string, name: string) => void;
  watchRoom: (roomId: string, name: string) => void;
  quickMatch: (name: string, gameType?: GameType) => void;
  refreshRooms: () => void;
  createAiRoom: (
    name: string,
    gameType: GameType,
    color?: CreateColor,
    boardSize?: number,
    botCount?: number,
    botDifficulty?: 'easy' | 'normal' | 'hard',
    matchSeconds?: number,
  ) => void;
  ready: () => void;
  move: (input: MoveInput) => void;
  rematch: () => void;
  resign: () => void;
  undoRequest: () => void;
  undoResponse: (accept: boolean) => void;
  leaveRoom: () => void;
  chat: (text: string) => void;
  notify: (text: string, level?: ToastLevel) => void;
  dismissToast: (id: number) => void;
}

export interface UseGameSocketResult {
  state: GameSocketState;
  actions: GameActions;
  /** 底层连接实例：实时游戏（坦克大战）用它收发二进制帧。 */
  socket: GameSocket;
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
        case 'records':
          dispatch({ type: 'records', records: message.records });
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
      gameType: GameType;
      roomName: string;
      visibility: RoomVisibility;
      color: CreateColor;
      boardSize?: number;
      matchSeconds?: number;
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
        gameType: options.gameType,
        visibility: options.visibility,
        color: options.color,
      };
      if (options.boardSize && options.gameType === 'gomoku') {
        payload.boardSize = options.boardSize;
      }
      if (options.matchSeconds && options.gameType === 'tank') {
        payload.matchSeconds = options.matchSeconds;
      }
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

    const watchRoom = (roomId: string, name: string): void => {
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
      const payload: WatchRoomPayload = { type: 'watch_room', roomId: code, name: trimmedName };
      send(payload);
    };

    const createAiRoom = (
      name: string,
      gameType: GameType,
      color: CreateColor = gameType === 'gomoku' ? 'black' : 'red',
      boardSize?: number,
      botCount?: number,
      botDifficulty?: 'easy' | 'normal' | 'hard',
      matchSeconds?: number,
    ): void => {
      const trimmedName = name.trim();
      if (!isValidNickname(trimmedName)) {
        pushToast('error', `昵称需为 1–${MAX_NICKNAME_LENGTH} 个字符`);
        return;
      }
      send({
        type: 'create_room',
        name: trimmedName,
        gameType,
        roomName: gameType === 'tank' ? '人机混战' : '人机对战',
        visibility: 'private',
        color,
        mode: 'ai',
        ...(gameType === 'gomoku' && boardSize ? { boardSize } : {}),
        ...(gameType === 'tank' && botCount ? { botCount } : {}),
        ...(gameType === 'tank' && botDifficulty ? { botDifficulty } : {}),
        ...(gameType === 'tank' && matchSeconds ? { matchSeconds } : {}),
      });
    };

    const quickMatch = (name: string, gameType: GameType = 'gomoku'): void => {
      const trimmedName = name.trim();
      if (!isValidNickname(trimmedName)) {
        pushToast('error', `昵称需为 1–${MAX_NICKNAME_LENGTH} 个字符`);
        return;
      }
      const payload: QuickMatchPayload = {
        type: 'quick_match',
        name: trimmedName,
        gameType,
      };
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

    const move = (input: MoveInput): void => {
      send({ type: 'move', ...input });
    };

    const rematch = (): void => {
      send({ type: 'rematch' });
    };

    const resign = (): void => {
      send({ type: 'resign' });
    };

    const undoRequest = (): void => {
      send({ type: 'undo_request' });
    };

    const undoResponse = (accept: boolean): void => {
      send({ type: 'undo_response', accept });
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
      createAiRoom,
      joinRoom,
      watchRoom,
      quickMatch,
      refreshRooms,
      ready,
      move,
      rematch,
      resign,
      undoRequest,
      undoResponse,
      leaveRoom,
      chat,
      notify,
      dismissToast,
    };
  }, [send, pushToast, notify, dismissToast]);

  return { state, actions, socket: socketRef.current };
}
