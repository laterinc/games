/**
 * 多游戏平台协议 v2 的 TypeScript 类型。
 * 房间生命周期（准备/悔棋/认输/观战/聊天/战绩）是通用的，棋盘与走法由 gameType 区分。
 */

export type GameType = 'gomoku' | 'chess' | 'tank';
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

/* --------------------------------- 坦克大战 -------------------------------- */

export interface TankObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TankSpawn {
  x: number;
  y: number;
}

export interface TankMap {
  width: number;
  height: number;
  obstacles: TankObstacle[];
  spawns: TankSpawn[];
  theme: string;
}

export interface TankScore {
  kills: number;
  deaths: number;
}

/** 实时对局里 `room.game` 的形状：只含地图与比分，实体走二进制快照。 */
export interface TankGame {
  phase: 'waiting' | 'playing' | 'finished';
  tickRate: number;
  map: TankMap | null;
  targetKills: number;
  endsAt: number | null;
  winnerId: string | null;
  endedReason: 'kills' | 'time' | 'forfeit' | null;
  scores: Record<string, TankScore>;
}

export type RoomGame = GomokuGame | ChessGame | TankGame;

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
  /** 实时游戏的座位序号（0–7），回合制为 null。 */
  slot?: number | null;
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
  | 'RATE_LIMITED';

/* ------------------------------ 服务端 → 客户端 ------------------------------ */

export interface WelcomeMessage {
  type: 'welcome';
  /** 浏览器身份 UUID：首次由服务端生成，之后由前端 localStorage 带回。 */
  playerId: string;
  reconnected: boolean;
  serverTime: number;
  protocolVersion: number;
  /** 服务端是否支持实时二进制帧（协议 v3 能力协商）。 */
  binary?: boolean;
  /** 实时游戏 tick 频率。 */
  tickRate?: number;
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

export type TankEventKind = 'hit' | 'kill' | 'respawn' | 'match_end' | 'impact';

export interface TankEvent {
  kind: TankEventKind;
  shooterId?: string;
  targetId?: string;
  playerId?: string;
  x?: number;
  y?: number;
  damage?: number;
  winnerId?: string | null;
  reason?: string;
  /** 命中表面类型：wall / obstacle（仅 impact 事件）。 */
  surface?: string;
}

export interface TankEventMessage {
  type: 'tank_event';
  event: TankEvent;
}

export type ServerMessage =
  | WelcomeMessage
  | RoomMessage
  | RoomsMessage
  | ChatEventMessage
  | NoticeMessage
  | ErrorMessage
  | PongMessage
  | RecordsMessage
  | TankEventMessage;

/* ------------------------------ 客户端 → 服务端 ------------------------------ */

export interface CreateRoomPayload {
  type: 'create_room';
  name: string;
  gameType?: GameType;
  roomName?: string;
  visibility?: RoomVisibility;
  color?: CreateColor;
  /** 仅五子棋：棋盘路数（9/11/13/15/17/19）。 */
  boardSize?: number;
  /** 仅坦克大战人机：电脑坦克数量 1–7。 */
  botCount?: number;
  /** 仅坦克大战人机：电脑难度。 */
  botDifficulty?: 'easy' | 'normal' | 'hard';
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
