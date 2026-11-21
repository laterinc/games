import type { GameListing } from './types';

/**
 * 尚未上线的游戏目录。这里只影响首页展示，不进入 GameType / 服务端协议，
 * 避免为了占位卡片去改房间、规则引擎和协议。
 */
export const tankGame: GameListing = {
  key: 'tank',
  game: null,
  label: '坦克大战',
  short: '实时对轰',
  icon: '坦',
  description: '驾驶坦克在掩体间穿梭，实时瞄准对轰，支持多名玩家同场竞技。',
  category: 'action',
  mode: 'realtime',
  players: '2–8 人',
  tags: ['实时对战', '多人在线', '开发中'],
  status: 'planned',
};

export const PLANNED_GAMES: readonly GameListing[] = [tankGame];
