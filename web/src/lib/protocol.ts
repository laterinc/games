/**
 * 运行时协议解析：把 WebSocket/REST 收到的未知 JSON 收敛成带类型的领域对象。
 * 前端不信任输入，任何字段缺失或类型不符都回落到安全默认值，避免渲染崩溃。
 */
import type {
  ChatMessage,
  ChessGame,
  ChessLegalMove,
  ChessMove,
  Color,
  CreateColor,
  EndReason,
  GameType,
  GomokuColor,
  GomokuGame,
  GomokuMove,
  MatchRecord,
  NoticeLevel,
  PendingUndo,
  Player,
  Point,
  Room,
  RoomStatus,
  RoomSummary,
  RoomVisibility,
  ServerMessage,
} from '../types';

export const DEFAULT_BOARD_SIZE = 15;
export const MAX_PLAYERS = 2;
export const MAX_CHAT_LENGTH = 200;
export const MAX_NICKNAME_LENGTH = 16;
export const MAX_ROOM_NAME_LENGTH = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asColor(value: unknown): Color | null {
  return value === 'black' || value === 'white' || value === 'red' ? value : null;
}

function asGomokuColor(value: unknown, fallback: GomokuColor = 'black'): GomokuColor {
  return value === 'black' || value === 'white' ? value : fallback;
}

function asChessColor(value: unknown, fallback: 'red' | 'black' = 'red'): 'red' | 'black' {
  return value === 'red' || value === 'black' ? value : fallback;
}

function asGameType(value: unknown): GameType {
  return value === 'chess' ? 'chess' : 'gomoku';
}

function asRoomStatus(value: unknown): RoomStatus {
  return value === 'playing' || value === 'finished' || value === 'waiting' ? value : 'waiting';
}

function asVisibility(value: unknown): RoomVisibility {
  return value === 'private' ? 'private' : 'public';
}

function asNoticeLevel(value: unknown): NoticeLevel {
  return value === 'success' || value === 'warn' ? value : 'info';
}

function asEndReason(value: unknown): EndReason | null {
  return value === 'five' ||
    value === 'draw' ||
    value === 'forfeit' ||
    value === 'resign' ||
    value === 'checkmate' ||
    value === 'stalemate'
    ? value
    : null;
}

function asGameMode(value: unknown): 'pvp' | 'ai' {
  return value === 'ai' ? 'ai' : 'pvp';
}

function asPendingUndo(value: unknown): PendingUndo | null {
  if (!isRecord(value)) return null;
  const playerId = asString(value.playerId);
  if (!playerId) return null;
  return { playerId, name: asString(value.name, '棋友') };
}

export function asBoardSize(value: unknown): number {
  const size = asNumber(value, DEFAULT_BOARD_SIZE);
  const rounded = Math.round(size);
  if (!Number.isFinite(rounded) || rounded < 5 || rounded > 25) {
    return DEFAULT_BOARD_SIZE;
  }
  return rounded;
}

function asPoint(value: unknown): Point | null {
  if (!isRecord(value)) return null;
  const row = asNumber(value.row, -1);
  const col = asNumber(value.col, -1);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return null;
  return { row, col };
}

function asPoints(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const points: Point[] = [];
  for (const item of value) {
    const point = asPoint(item);
    if (!point) return null;
    points.push(point);
  }
  return points;
}

function asBoard(value: unknown, size: number): number[][] {
  const rawRows: unknown[] = Array.isArray(value) ? value : [];
  const board: number[][] = [];
  for (let row = 0; row < size; row += 1) {
    const rawRow: unknown[] = Array.isArray(rawRows[row]) ? (rawRows[row] as unknown[]) : [];
    const cells: number[] = [];
    for (let col = 0; col < size; col += 1) {
      const cell = rawRow[col];
      cells.push(cell === 1 ? 1 : cell === 2 ? 2 : 0);
    }
    board.push(cells);
  }
  return board;
}

function asGomokuMoveList(value: unknown): GomokuMove[] {
  if (!Array.isArray(value)) return [];
  const moves: GomokuMove[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const point = asPoint(item);
    const color = asColor(item.color);
    if (!point || (color !== 'black' && color !== 'white')) continue;
    moves.push({ row: point.row, col: point.col, color, at: asNumber(item.at, 0) });
  }
  return moves;
}

function asChessMove(value: unknown): ChessMove | null {
  if (!isRecord(value)) return null;
  const from = asPoint(value.from);
  const to = asPoint(value.to);
  const color = asChessColor(value.color, 'red');
  if (!from || !to) return null;
  return {
    from,
    to,
    piece: asString(value.piece),
    captured: typeof value.captured === 'string' ? value.captured : null,
    color,
    notation: asString(value.notation),
    at: asNumber(value.at, 0),
  };
}

function asChessMoveList(value: unknown): ChessMove[] {
  if (!Array.isArray(value)) return [];
  const moves: ChessMove[] = [];
  for (const item of value) {
    const move = asChessMove(item);
    if (move) moves.push(move);
  }
  return moves;
}

function asChessLegalMoves(value: unknown): ChessLegalMove[] {
  if (!Array.isArray(value)) return [];
  const moves: ChessLegalMove[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const from = asPoint(item.from);
    const to = asPoint(item.to);
    if (from && to) moves.push({ from, to });
  }
  return moves;
}

function asChessBoard(value: unknown, rows: number, cols: number): (string | null)[][] {
  const rawRows: unknown[] = Array.isArray(value) ? value : [];
  const board: (string | null)[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const rawRow = Array.isArray(rawRows[row]) ? (rawRows[row] as unknown[]) : [];
    const cells: (string | null)[] = [];
    for (let col = 0; col < cols; col += 1) {
      const cell = rawRow[col];
      cells.push(typeof cell === 'string' && cell ? cell : null);
    }
    board.push(cells);
  }
  return board;
}

function asCaptured(value: unknown): { red: string[]; black: string[] } {
  const raw = isRecord(value) ? value : {};
  const asList = (items: unknown): string[] =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
  return { red: asList(raw.red), black: asList(raw.black) };
}

function asPlayer(value: unknown, index: number): Player | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    name: asString(value.name, '棋友'),
    color: asColor(value.color) ?? (index === 0 ? 'black' : 'white'),
    connected: asBoolean(value.connected, true),
    ready: asBoolean(value.ready, false),
    isHost: asBoolean(value.isHost, index === 0),
    isBot: asBoolean(value.isBot, false),
  };
}

function asPlayers(value: unknown): Player[] {
  if (!Array.isArray(value)) return [];
  const players: Player[] = [];
  for (const [index, item] of value.entries()) {
    const player = asPlayer(item, index);
    if (player) players.push(player);
  }
  return players;
}

function asChatMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    playerId: asString(value.playerId),
    name: asString(value.name, '棋友'),
    text: asString(value.text),
    at: asNumber(value.at, 0),
  };
}

function asChatList(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ChatMessage[] = [];
  for (const item of value) {
    const message = asChatMessage(item);
    if (message) messages.push(message);
  }
  return messages;
}

export function normalizeGomokuGame(value: unknown): GomokuGame {
  const raw = isRecord(value) ? value : {};
  const size = asBoardSize(raw.boardSize);
  const winner = raw.winner === 'black' || raw.winner === 'white' ? raw.winner : null;
  return {
    boardSize: size,
    board: asBoard(raw.board, size),
    currentTurn: asGomokuColor(raw.currentTurn),
    lastMove: asPoint(raw.lastMove),
    moves: asGomokuMoveList(raw.moves),
    winner,
    winLine: asPoints(raw.winLine),
    endedReason: asEndReason(raw.endedReason),
    startedAt: asTimestamp(raw.startedAt),
    endedAt: asTimestamp(raw.endedAt),
  };
}

export function normalizeChessGame(value: unknown): ChessGame {
  const raw = isRecord(value) ? value : {};
  const rows = Math.min(16, Math.max(4, Math.round(asNumber(raw.rows, 10))));
  const cols = Math.min(16, Math.max(4, Math.round(asNumber(raw.cols, 9))));
  const winner = raw.winner === 'red' || raw.winner === 'black' ? raw.winner : null;
  const lastMoveRaw = isRecord(raw.lastMove) ? raw.lastMove : null;
  const lastMoveFrom = lastMoveRaw ? asPoint(lastMoveRaw.from) : null;
  const lastMoveTo = lastMoveRaw ? asPoint(lastMoveRaw.to) : null;
  return {
    rows,
    cols,
    board: asChessBoard(raw.board, rows, cols),
    currentTurn: asChessColor(raw.currentTurn),
    lastMove:
      lastMoveFrom && lastMoveTo ? { from: lastMoveFrom, to: lastMoveTo } : null,
    moves: asChessMoveList(raw.moves),
    winner,
    winLine: null,
    endedReason: asEndReason(raw.endedReason),
    startedAt: asTimestamp(raw.startedAt),
    endedAt: asTimestamp(raw.endedAt),
    check: asBoolean(raw.check, false),
    legalMoves: asChessLegalMoves(raw.legalMoves),
    captured: asCaptured(raw.captured),
  };
}

export function normalizeGame(value: unknown, gameType: GameType): GomokuGame | ChessGame {
  return gameType === 'chess' ? normalizeChessGame(value) : normalizeGomokuGame(value);
}

export function normalizeRoom(value: unknown): Room | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  const players = asPlayers(value.players);
  const rematchVotes = Array.isArray(value.rematchVotes)
    ? value.rematchVotes.filter((vote): vote is string => typeof vote === 'string')
    : [];
  const gameType = asGameType(value.gameType);
  return {
    id,
    name: asString(value.name, `房间 ${id}`),
    visibility: asVisibility(value.visibility),
    gameType,
    status: asRoomStatus(value.status),
    hostId: asString(value.hostId),
    createdAt: asNumber(value.createdAt, Date.now()),
    updatedAt: asNumber(value.updatedAt, Date.now()),
    players,
    spectators: asNumber(value.spectators, 0),
    rematchVotes,
    mode: asGameMode(value.mode),
    pendingUndo: asPendingUndo(value.pendingUndo),
    game: normalizeGame(value.game, gameType),
    chat: Array.isArray(value.chat) ? asChatList(value.chat) : undefined,
  };
}

export function normalizeRoomSummary(value: unknown): RoomSummary | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    name: asString(value.name, `房间 ${id}`),
    gameType: asGameType(value.gameType),
    boardSize: asNumber(value.boardSize, DEFAULT_BOARD_SIZE),
    status: asRoomStatus(value.status),
    playerCount: asNumber(value.playerCount, 0),
    maxPlayers: asNumber(value.maxPlayers, MAX_PLAYERS),
    hostName: asString(value.hostName, '未知玩家'),
    createdAt: asNumber(value.createdAt, Date.now()),
  };
}

export function normalizeRoomSummaries(value: unknown): RoomSummary[] {
  if (!Array.isArray(value)) return [];
  const rooms: RoomSummary[] = [];
  for (const item of value) {
    const room = normalizeRoomSummary(item);
    if (room) rooms.push(room);
  }
  return rooms;
}

/** 解析 REST GET /api/rooms 响应体：{"rooms":[...]}。 */
export function parseRoomListPayload(value: unknown): RoomSummary[] {
  if (!isRecord(value)) return [];
  return normalizeRoomSummaries(value.rooms);
}

function asMatchRecord(value: unknown): MatchRecord | null {
  if (!isRecord(value)) return null;
  const result = value.result;
  if (result !== 'win' && result !== 'loss' && result !== 'draw') return null;
  return {
    result,
    opponent: asString(value.opponent),
    mode: asGameMode(value.mode),
    gameType: asGameType(value.gameType),
    endedReason: asEndReason(value.endedReason),
    moves: asNumber(value.moves, 0),
    myColor: asColor(value.myColor) ?? 'black',
    at: asNumber(value.at, 0),
  };
}

function asRecords(value: unknown): MatchRecord[] {
  if (!Array.isArray(value)) return [];
  const records: MatchRecord[] = [];
  for (const item of value) {
    const record = asMatchRecord(item);
    if (record) records.push(record);
  }
  return records;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

/**
 * 解析服务端文本帧。未知 type / 解析失败返回 null（按协议忽略）。
 * 单个字段不合法时使用安全默认值，避免整条消息被丢弃。
 */
export function parseServerMessage(data: string): ServerMessage | null {
  const parsed = parseJson(data);
  if (!isRecord(parsed)) return null;
  const type = asString(parsed.type);
  switch (type) {
    case 'welcome': {
      const playerId = asString(parsed.playerId);
      const token = asString(parsed.token);
      if (!playerId || !token) return null;
      return {
        type: 'welcome',
        playerId,
        token,
        reconnected: asBoolean(parsed.reconnected, false),
        serverTime: asNumber(parsed.serverTime, Date.now()),
        protocolVersion: asNumber(parsed.protocolVersion, 1),
      };
    }
    case 'room':
      return { type: 'room', room: parsed.room === null ? null : normalizeRoom(parsed.room) };
    case 'rooms':
      return { type: 'rooms', rooms: normalizeRoomSummaries(parsed.rooms) };
    case 'chat': {
      const message = asChatMessage(parsed.message);
      return message ? { type: 'chat', message } : null;
    }
    case 'notice':
      return {
        type: 'notice',
        level: asNoticeLevel(parsed.level),
        text: asString(parsed.text),
      };
    case 'error':
      return {
        type: 'error',
        code: asString(parsed.code, 'UNKNOWN'),
        message: asString(parsed.message, '发生未知错误'),
      };
    case 'pong':
      return { type: 'pong', t: asNumber(parsed.t, 0) };
    case 'records':
      return { type: 'records', records: asRecords(parsed.records) };
    default:
      return null;
  }
}

/* --------------------------------- 展示文案 --------------------------------- */

export const COLOR_LABEL: Record<Color, string> = {
  black: '黑棋',
  white: '白棋',
  red: '红棋',
};

export const ROOM_STATUS_LABEL: Record<RoomStatus, string> = {
  waiting: '等待中',
  playing: '对局中',
  finished: '已结束',
};

export const CREATE_COLOR_LABEL: Record<CreateColor, string> = {
  black: '执黑先行',
  white: '执白后行',
  red: '执红先行',
  random: '随机分配',
};

export const ERROR_CODE_LABEL: Record<string, string> = {
  INVALID_MESSAGE: '消息格式有误',
  UNKNOWN_TYPE: '未知的消息类型',
  INVALID_NAME: '昵称需为 1–16 个字符',
  INVALID_ROOM_NAME: '房间名需为 0–24 个字符',
  ALREADY_IN_ROOM: '你已经在房间中',
  NOT_IN_ROOM: '你不在房间中',
  ROOM_NOT_FOUND: '房间不存在或已解散',
  ROOM_FULL: '房间已满',
  ROOM_STARTED: '对局已开始，无法加入',
  NOT_YOUR_TURN: '还没轮到你落子',
  INVALID_MOVE: '坐标无效或该点已有棋子',
  GAME_NOT_ACTIVE: '当前不在对局中',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  AUTH_FAILED: '身份校验失败，已切换为新身份',
};
