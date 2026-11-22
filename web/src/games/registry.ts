import type { GameType } from '../types';
import { chessGame } from './chess/meta';
import { gomokuGame } from './gomoku/meta';
import { tankGame } from './tank/meta';
import { PLANNED_GAMES } from './planned';
import type { GameCategory, GameDefinition, GameListing } from './types';

/**
 * 前端游戏注册表。新增游戏时：
 *   1. 新建 games/<slug>/ 目录，提供 meta.ts 与棋盘/对局组件；
 *   2. 在这里登记到 GAMES / GAME_LIST；
 *   3. 在 types.ts 增加该游戏的 GameType 与 RoomGame 分支。
 * 路由、首页卡片、游戏切换、创建房间的颜色选项都会自动跟随。
 *
 * 只是规划中的游戏放 planned.ts 的 PLANNED_GAMES，不要改 GameType。
 */
export const GAMES: Record<GameType, GameDefinition> = {
  gomoku: gomokuGame,
  chess: chessGame,
  tank: tankGame,
};

/** 游戏切换卡的展示顺序。 */
export const GAME_LIST: readonly GameDefinition[] = [gomokuGame, chessGame, tankGame];

export const DEFAULT_GAME: GameType = 'gomoku';

export const GAME_LABEL: Record<GameType, string> = {
  gomoku: gomokuGame.label,
  chess: chessGame.label,
  tank: tankGame.label,
};

export const GAME_CATEGORIES: readonly {
  key: GameCategory;
  label: string;
  description: string;
}[] = [
  {
    key: 'board',
    label: '棋类对战',
    description: '回合一局，适合边聊边下。',
  },
  {
    key: 'action',
    label: '实时对战',
    description: '实时开打，和朋友一起更热闹。',
  },
];

function toListing(game: GameDefinition): GameListing {
  return {
    key: game.type,
    game: game.type,
    label: game.label,
    short: game.short,
    icon: game.icon,
    description: game.description,
    category: game.category,
    mode: game.mode,
    players: game.players,
    tags: game.tags,
    status: 'available',
  };
}

/** 首页游戏目录：已上线游戏 + 开发中游戏。 */
export const GAME_CATALOG: readonly GameListing[] = [
  ...GAME_LIST.map(toListing),
  ...PLANNED_GAMES,
];

export function gameFromSlug(slug: string): GameType | null {
  const found = GAME_LIST.find((game) => game.slug === slug);
  return found ? found.type : null;
}

export function gameSlug(game: GameType): string {
  return GAMES[game].slug;
}
