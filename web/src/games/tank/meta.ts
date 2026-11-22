import type { GameDefinition } from '../types';

/** 坦克大战：实时 3D 自由混战，走 /tank 路由，房间与大厅复用现有通用组件。 */
export const tankGame: GameDefinition = {
  type: 'tank',
  slug: 'tank',
  label: '坦克大战',
  short: '实时对轰',
  icon: '坦',
  category: 'action',
  mode: 'realtime',
  players: '2–8 人',
  description: '驾驶坦克在掩体间穿梭，实时瞄准对轰，和朋友来一场热闹的 3D 混战。',
  tags: ['实时对战', '好友同场', '3D'],
  note: '自由混战：先到 15 杀或 180 秒结束，按击杀数排名。',
  guide: ['WASD 开车，鼠标瞄准炮塔', '左键或空格开火，装填 0.9 秒', '先到 15 杀拿下本局'],
  colorOptions: [{ value: 'red', label: '自由混战' }],
  defaultColor: 'red',
  // 实时游戏没有先手执子，座位颜色仅用于通用座位卡片的兼容展示。
  seatColors: ['red', 'red'],
  moveVerb: '走子',
  boardFooter: '20Hz 服务端权威模拟 · 二进制快照 · 2–8 人自由混战',
};
