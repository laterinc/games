import type { GameDefinition } from '../types';

export const chessGame: GameDefinition = {
  type: 'chess',
  slug: 'chess',
  label: '中国象棋',
  short: '将死获胜',
  category: 'board',
  mode: 'turn-based',
  players: '2 人',
  icon: '象',
  description: '九路十行，红棋先行，将死或困毙对手获胜。快速匹配棋友，或邀请好友杀一盘。',
  tags: ['9×10 标准棋盘', '服务端裁判', '完整走子规则 · 支持观战'],
  note: '车马炮卒，楚河汉界，将死或困毙即胜',
  guide: ['匹配或建房', '双方准备，红棋先行', '将死或困毙对手获胜'],
  colorOptions: [
    { value: 'red', label: '执红先行' },
    { value: 'black', label: '执黑后行' },
    { value: 'random', label: '随机分配' },
  ],
  defaultColor: 'red',
  seatColors: ['red', 'black'],
  moveVerb: '走子',
  boardFooter: '红棋先行 · 将死或困毙获胜',
};
