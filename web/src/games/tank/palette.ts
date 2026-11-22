/**
 * 坦克大战配色板（与 docs/TANK.md §1 的座位色板一致，服务端 SLOT_COLORS 同序）。
 *
 * 顺序固定为：红、橙、黄、绿、青、蓝、紫、粉（server/app/games/tank.py 的 SLOT_COLORS），
 * 索引即座位 slot（0–7）；渲染层拿到的实体已带 ownerSlot，直接查表即可，
 * HUD/击杀播报用 SLOT_LABELS 取中文色名。
 */

/** 8 个座位色，索引即 slot。 */
export const TANK_COLORS: readonly string[] = [
  '#e5544b', // 0 红
  '#f5a623', // 1 橙
  '#c9d44a', // 2 黄
  '#37c98b', // 3 绿
  '#22c3d6', // 4 青
  '#4f8cff', // 5 蓝
  '#b06bff', // 6 紫
  '#f06292', // 7 粉
];

/** 与 TANK_COLORS 一一对应的中文色名。 */
export const SLOT_LABELS: readonly string[] = ['红', '橙', '黄', '绿', '青', '蓝', '紫', '粉'];
