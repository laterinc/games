/**
 * 多游戏平台协议 v2 的 TypeScript 类型。
 * 房间生命周期（准备/悔棋/认输/观战/聊天/战绩）是通用的，棋盘与走法由 gameType 区分。
 */

export type GameType = 'gomoku' | 'chess';
export type Color = 'black' | 'white' | 'red';
export type GomokuColor = 'black' | 'white';
export type ChessColor = 'red' | 'black';
export type RoomVisibility = 'public' | 'private';
export type RoomStatus = 'waiting' | 'playing' | 'finished';
export type EndReason =
  | 'five'
  | 'draw'
  | 'forfeit'
  | 'resign'
  | 'checkmate'
  | 'stalemate';
export type NoticeLevel = 'info' | 'success' | 'warn';
export type CreateColor = Color | 'random';
export type MatchResult = 'win' | 'loss' | 'draw';

export interface Point {
  row: number;
  col: number;
}

/* -------------------------------- 五子棋 -------------------------------- */

export interface GomokuMove extends Point {
  color: GomokuColor;
  at: number;
}

export interface GomokuGame {
  boardSize: number;
  /** 下标 [row][col]，row 从上到下、col 从左到右，均从 0 开始。 */
  board: number[][];
  currentTurn: GomokuColor;
  lastMove: Point | null;
  moves: GomokuMove[];
  winner: GomokuColor | null;
  winLine: Point[] | null;
  endedReason: EndReason | null;
  startedAt: number | null;
  endedAt: number | null;
}

/* -------------------------------- 中国象棋 ------------------------------- */

export interface ChessMove {
  from: Point;
  to: Point;
  /** 棋子编码：红方大写 K/A/B/N/R/C/P，黑方小写 k/a/b/n/r/c/p。 */
  piece: string;
  captured: string | null;
  color: ChessColor;
  notation: string;
  at: number;
}

export interface ChessLegalMove {
  from: Point;
  to: Point;
}

export interface ChessGame {
  rows: number;
  cols: number;
  board: (string | null)[][];
  currentTurn: ChessColor;
  lastMove: { from: Point; to: Point } | null;
  moves: ChessMove[];
  winner: ChessColor | null;
  winLine: null;
  endedReason: EndReason | null;
  startedAt: number | null;
  endedAt: number | null;
  check: boolean;
  legalMoves: ChessLegalMove[];
  captured: { red: string[]; black: string[] };
}

export type RoomGame = GomokuGame | ChessGame;

/* -------------------------------- 房间 -------------------------------- */

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

export interface ChatMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  at: number;
}

export interface PendingUndo {
  playerId: string;
  name: string;
}

export interface Room {
  id: string;
  name: string;
  visibility: RoomVisibility;
  gameType: GameType;
  status: RoomStatus;
  hostId: string;
  createdAt: number;
  updatedAt: number;
  players: Player[];
  spectators: number;
  rematchVotes: string[];
  /** pvp 联机 / ai 人机。 */
  mode: 'pvp' | 'ai';
  /** 待处理的悔棋请求。 */
  pendingUndo: PendingUndo | null;
  game: RoomGame;
  /** 最近 50 条聊天记录，随快照下发。 */
  chat?: ChatMessage[];
}

export interface RoomSummary {
  id: string;
  name: string;
  gameType: GameType;
  /** 五子棋棋盘路数；象棋固定 9×10。 */
  boardSize?: number;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  hostName: string;
  createdAt: number;
}

export interface MatchRecord {
  result: MatchResult;
  opponent: string;
  mode: 'pvp' | 'ai';
  gameType: GameType;
  endedReason: EndReason | null;
  moves: number;
  myColor: Color;
  at: number;
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
  gameType?: GameType;
  roomName?: string;
  visibility?: RoomVisibility;
  color?: CreateColor;
  /** 仅五子棋：棋盘路数（9/11/13/15/17/19）。 */
  boardSize?: number;
  mode?: 'pvp' | 'ai';
}

export interface JoinRoomPayload {
  type: 'join_room';
  roomId: string;
  name: string;
}

export interface QuickMatchPayload {
  type: 'quick_match';
  name: string;
  gameType?: GameType;
}

export interface WatchRoomPayload {
  type: 'watch_room';
  roomId: string;
  name: string;
}

export interface ListRoomsPayload {
  type: 'list_rooms';
  gameType?: GameType;
}

export interface ReadyPayload {
  type: 'ready';
}

export type GomokuMoveInput = Point;
export interface ChessMoveInput {
  from: Point;
  to: Point;
}
export type MoveInput = GomokuMoveInput | ChessMoveInput;
export type MovePayload = MoveInput & { type: 'move' };

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

export interface GameMeta {
  key: GameType;
  name: string;
  colors: Color[];
  createColors: CreateColor[];
}
