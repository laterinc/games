/**
 * 五子棋联机协议 v1 的 TypeScript 类型。
 * 字段名、枚举值严格对齐 gomoku/PROTOCOL.md，服务端为唯一裁判。
 */

export type Color = 'black' | 'white';
export type RoomVisibility = 'public' | 'private';
export type RoomStatus = 'waiting' | 'playing' | 'finished';
export type EndReason = 'five' | 'draw' | 'forfeit' | 'resign';
export type NoticeLevel = 'info' | 'success' | 'warn';
export type CreateColor = Color | 'random';
export type GameMode = 'pvp' | 'ai';
export type MatchResult = 'win' | 'loss' | 'draw';

export interface Point {
  row: number;
  col: number;
}

export interface Move extends Point {
  color: Color;
  at: number;
}

export interface Player {
  id: string;
  name: string;
  color: Color;
  connected: boolean;
  ready: boolean;
  isHost: boolean;
  /** 是否为人机对战中的电脑。 */
  isBot: boolean;
}

export interface PendingUndo {
  playerId: string;
  name: string;
}

export interface MatchRecord {
  result: MatchResult;
  opponent: string;
  mode: GameMode;
  endedReason: EndReason | null;
  moves: number;
  myColor: Color;
  at: number;
}

export interface Game {
  boardSize: number;
  /** 下标 [row][col]，row 从上到下、col 从左到右，均从 0 开始。 */
  board: number[][];
  currentTurn: Color;
  lastMove: Point | null;
  moves: Move[];
  winner: Color | null;
  winLine: Point[] | null;
  endedReason: EndReason | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  at: number;
}

export interface Room {
  id: string;
  name: string;
  visibility: RoomVisibility;
  status: RoomStatus;
  hostId: string;
  createdAt: number;
  updatedAt: number;
  players: Player[];
  spectators: number;
  rematchVotes: string[];
  /** pvp 联机 / ai 人机。 */
  mode: GameMode;
  /** 待处理的悔棋请求。 */
  pendingUndo: PendingUndo | null;
  game: Game;
  /** 最近 50 条聊天记录（协议 3.10，随快照下发）。 */
  chat?: ChatMessage[];
}

export interface RoomSummary {
  id: string;
  name: string;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  hostName: string;
  createdAt: number;
}

export type ErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_TYPE'
  | 'INVALID_NAME'
  | 'INVALID_ROOM_NAME'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_STARTED'
  | 'NOT_YOUR_TURN'
  | 'INVALID_MOVE'
  | 'GAME_NOT_ACTIVE'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED';

/* ------------------------------ 服务端 → 客户端 ------------------------------ */

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  token: string;
  reconnected: boolean;
  serverTime: number;
  protocolVersion: number;
}

export interface RoomMessage {
  type: 'room';
  room: Room | null;
}

export interface RoomsMessage {
  type: 'rooms';
  rooms: RoomSummary[];
}

export interface ChatEventMessage {
  type: 'chat';
  message: ChatMessage;
}

export interface NoticeMessage {
  type: 'notice';
  level: NoticeLevel;
  text: string;
}

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode | string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  t: number;
}

export interface RecordsMessage {
  type: 'records';
  records: MatchRecord[];
}

export type ServerMessage =
  | WelcomeMessage
  | RoomMessage
  | RoomsMessage
  | ChatEventMessage
  | NoticeMessage
  | ErrorMessage
  | PongMessage
  | RecordsMessage;

/* ------------------------------ 客户端 → 服务端 ------------------------------ */

export interface HelloPayload {
  type: 'hello';
  playerId: string;
  token: string;
}

export interface CreateRoomPayload {
  type: 'create_room';
  name: string;
  roomName?: string;
  visibility?: RoomVisibility;
  color?: CreateColor;
  mode?: GameMode;
}

export interface JoinRoomPayload {
  type: 'join_room';
  roomId: string;
  name: string;
}

export interface QuickMatchPayload {
  type: 'quick_match';
  name: string;
}

export interface WatchRoomPayload {
  type: 'watch_room';
  roomId: string;
  name: string;
}

export interface ListRoomsPayload {
  type: 'list_rooms';
}

export interface ReadyPayload {
  type: 'ready';
}

export interface MovePayload {
  type: 'move';
  row: number;
  col: number;
}

export interface RematchPayload {
  type: 'rematch';
}

export interface ResignPayload {
  type: 'resign';
}

export interface UndoRequestPayload {
  type: 'undo_request';
}

export interface UndoResponsePayload {
  type: 'undo_response';
  accept: boolean;
}

export interface LeaveRoomPayload {
  type: 'leave_room';
}

export interface ChatPayload {
  type: 'chat';
  text: string;
}

export interface PingPayload {
  type: 'ping';
}

export type ClientMessage =
  | HelloPayload
  | CreateRoomPayload
  | JoinRoomPayload
  | QuickMatchPayload
  | WatchRoomPayload
  | ListRoomsPayload
  | ReadyPayload
  | MovePayload
  | RematchPayload
  | ResignPayload
  | UndoRequestPayload
  | UndoResponsePayload
  | LeaveRoomPayload
  | ChatPayload
  | PingPayload;

/* ------------------------------ 展示辅助类型 ------------------------------ */

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  level: ToastLevel;
  text: string;
}
