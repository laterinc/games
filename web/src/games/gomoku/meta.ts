import type { GameDefinition } from '../types';

export const gomokuGame: GameDefinition = {
  type: 'gomoku',
  slug: 'gomoku',
  label: '五子棋',
  short: '五连获胜',
  category: 'board',
  mode: 'turn-based',
  players: '2 人',
  icon: '五',
  description: '十五路棋盘，黑棋先行，先连成五子者胜。适合和老朋友来一盘，随时开局。',
  tags: ['15×15 棋盘', '五连获胜', '支持观战'],
  note: '横 · 竖 · 斜，任意方向连成五子即胜',
  guide: ['匹配或建房', '双方准备，黑棋先行', '横竖斜先连五子获胜'],
  colorOptions: [
    { value: 'black', label: '执黑先行' },
    { value: 'white', label: '执白后行' },
    { value: 'random', label: '随机分配' },
  ],
  defaultColor: 'black',
  seatColors: ['black', 'white'],
  moveVerb: '落子',
  boardFooter: '黑棋先行 · 五连获胜',
};
