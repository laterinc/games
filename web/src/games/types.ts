import type { Color, CreateColor, GameType } from '../types';

/** 首页分组：棋类（回合制）与实时对战。 */
export type GameCategory = 'board' | 'action';
export type GameMode = 'turn-based' | 'realtime';
export type GameStatus = 'available' | 'planned';

/** 一个游戏的静态定义：路由、文案、座位与颜色选项都由这里提供。 */
export interface GameDefinition {
  type: GameType;
  /** URL 片段，例如 /gomoku、/chess。 */
  slug: string;
  label: string;
  /** 游戏切换卡片上的副标题，例如「五连获胜」。 */
  short: string;
  /** 游戏切换卡片上的单字图标。 */
  icon: string;
  category: GameCategory;
  mode: GameMode;
  /** 首页展示的玩家人数，例如「2 人」「2–8 人」。 */
  players: string;
  eyebrow: string;
  description: string;
  tags: string[];
  note: string;
  guide: [string, string, string];
  colorOptions: Array<{ value: CreateColor; label: string }>;
  defaultColor: CreateColor;
  /** 对局页左右两个座位的颜色顺序（先手在前）。 */
  seatColors: [Color, Color];
  /** 对局动作的动词：落子 / 走子。 */
  moveVerb: '落子' | '走子';
  boardFooter: string;
}

/** 首页游戏卡：已上线游戏来自 GameDefinition，未上线游戏只出现在目录里。 */
export interface GameListing {
  key: string;
  /** 已上线游戏的类型；开发中的游戏为 null。 */
  game: GameType | null;
  label: string;
  short: string;
  icon: string;
  description: string;
  category: GameCategory;
  mode: GameMode;
  players: string;
  tags: string[];
  status: GameStatus;
}
