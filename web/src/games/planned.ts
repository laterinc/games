import type { GameListing } from './types';

/**
 * 尚未上线的游戏目录。这里只影响首页展示，不进入 GameType / 服务端协议，
 * 避免为了占位卡片去改房间、规则引擎和协议。
 */
export const PLANNED_GAMES: readonly GameListing[] = [];
