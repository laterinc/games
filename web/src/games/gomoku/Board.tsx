import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { GomokuColor, GomokuGame, Point } from '../types';

interface BoardProps {
  game: GomokuGame;
  /** 我的执子颜色；null 表示没有可操作的颜色。 */
  myColor: GomokuColor | null;
  /** 当前是否允许落子（轮到自己 + 连接正常 + 无待确认落子）。 */
  interactive: boolean;
  /** 已点击、等待服务端确认的乐观落子（立刻显示半透明棋子）。 */
  pendingMove?: Point | null;
  onMove: (row: number, col: number) => void;
}

const CELL = 40;
const PAD = 38;
const STONE_RADIUS = 17.4;
const MIN_BOARD_SIZE = 5;
const MAX_BOARD_SIZE = 25;

const DROP_MS = 190;
const RIPPLE_MS = 520;
const WIN_MS = 520;

const SPRITE_SIZE = 200;
const SPRITE_CENTER = SPRITE_SIZE / 2;
const SPRITE_RADIUS = 80;

function clampBoardSize(value: number): number {
  const size = Math.round(value);
  if (!Number.isFinite(size) || size < MIN_BOARD_SIZE || size > MAX_BOARD_SIZE) return 15;
  return size;
}

/** 星位：四角 + 天元（15 路即经典五点）。 */
function starPoints(size: number): Point[] {
  const edge = size >= 15 ? 3 : 2;
  const far = size - 1 - edge;
  const candidates: Point[] = [
    { row: edge, col: edge },
    { row: edge, col: far },
    { row: far, col: edge },
    { row: far, col: far },
  ];
  const center = (size - 1) / 2;
  if (Number.isInteger(center) && center > edge && center < far) {
    candidates.push({ row: center, col: center });
  }
  const seen = new Set<string>();
  return candidates.filter((point) => {
    const key = `${point.row}:${point.col}`;
    if (point.row < 0 || point.col < 0 || point.row >= size || point.col >= size) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stoneColorAt(board: number[][], row: number, col: number): GomokuColor | null {
  const cell = board[row]?.[col] ?? 0;
  if (cell === 1) return 'black';
  if (cell === 2) return 'white';
  return null;
}

/* ----------------------------- 棋子精灵缓存 ----------------------------- */

let sprites: Record<GomokuColor, HTMLCanvasElement> | null = null;

function buildStoneSprite(color: GomokuColor): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.save();
  ctx.shadowColor = 'rgba(12, 8, 3, 0.55)';
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 7;

  const gradient = ctx.createRadialGradient(
    SPRITE_CENTER - SPRITE_RADIUS * 0.34,
    SPRITE_CENTER - SPRITE_RADIUS * 0.38,
    SPRITE_RADIUS * 0.1,
    SPRITE_CENTER,
    SPRITE_CENTER,
    SPRITE_RADIUS * 1.02,
  );
  if (color === 'black') {
    gradient.addColorStop(0, '#7b8492');
    gradient.addColorStop(0.32, '#3a4049');
    gradient.addColorStop(0.72, '#1b1f25');
    gradient.addColorStop(1, '#05070a');
  } else {
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.46, '#f2f4f7');
    gradient.addColorStop(0.82, '#d8dee5');
    gradient.addColorStop(1, '#aeb8c2');
  }
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(SPRITE_CENTER, SPRITE_CENTER, SPRITE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 高光
  ctx.save();
  ctx.translate(SPRITE_CENTER - 14, SPRITE_CENTER - 18);
  ctx.rotate(-0.42);
  ctx.fillStyle =
    color === 'white' ? 'rgba(255, 255, 255, 0.86)' : 'rgba(255, 255, 255, 0.34)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 17, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  return canvas;
}

function getStoneSprite(color: GomokuColor): HTMLCanvasElement {
  if (!sprites) {
    sprites = {
      black: buildStoneSprite('black'),
      white: buildStoneSprite('white'),
    };
  }
  return sprites[color];
}

/** 精灵中棋子直径占画布的比例，用于把精灵缩放到棋盘坐标。 */
const SPRITE_STONE_RATIO = (SPRITE_RADIUS * 2) / SPRITE_SIZE;

function drawStoneSprite(
  ctx: CanvasRenderingContext2D,
  color: GomokuColor,
  cx: number,
  cy: number,
  scale = 1,
  alpha = 1,
): void {
  const diameter = (STONE_RADIUS * 2) / SPRITE_STONE_RATIO;
  const size = diameter * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(getStoneSprite(color), cx - size / 2, cy - size / 2, size, size);
  ctx.restore();
}

/* ----------------------------- 绘制工具 ----------------------------- */

function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function paintBase(ctx: CanvasRenderingContext2D, size: number): void {
  const dimension = (size - 1) * CELL + PAD * 2;
  ctx.clearRect(0, 0, dimension, dimension);

  ctx.strokeStyle = 'rgba(74, 44, 16, 0.46)';
  ctx.lineWidth = 1;
  const end = PAD + (size - 1) * CELL;
  for (let index = 0; index < size; index += 1) {
    const pos = PAD + index * CELL;
    ctx.beginPath();
    ctx.moveTo(PAD, pos);
    ctx.lineTo(end, pos);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos, PAD);
    ctx.lineTo(pos, end);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(74, 44, 16, 0.6)';
  ctx.font = '600 11px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let index = 0; index < size; index += 1) {
    ctx.fillText(
      String.fromCharCode(65 + index),
      PAD + index * CELL,
      PAD - 17,
    );
    ctx.fillText(String(index + 1), PAD - 18, PAD + index * CELL + 1);
  }

  ctx.fillStyle = 'rgba(74, 44, 16, 0.62)';
  for (const point of starPoints(size)) {
    ctx.beginPath();
    ctx.arc(PAD + point.col * CELL, PAD + point.row * CELL, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

interface AnimState {
  lastKey: string | null;
  lastStart: number;
  winKey: string | null;
  winStart: number;
  pendingKey: string | null;
  pendingStart: number;
}

/** Canvas 棋盘：静态网格缓存 + 动态棋子层 + 逐帧动画，无 SVG/DOM 棋子。 */
function BoardComponent({ game, myColor, interactive, pendingMove, onMove }: BoardProps) {
  const size = clampBoardSize(game.boardSize);
  const dimension = (size - 1) * CELL + PAD * 2;
  const board = game.board;

  const frameRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stonesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const baseKeyRef = useRef('');
  const stonesKeyRef = useRef('');
  const boardRef = useRef<number[][] | null>(null);
  const animRef = useRef<AnimState>({
    lastKey: null,
    lastStart: 0,
    winKey: null,
    winStart: 0,
    pendingKey: null,
    pendingStart: 0,
  });
  const renderRef = useRef<(now: number) => void>(() => {});
  const animatingRef = useRef<(now: number) => boolean>(() => false);

  const [sizePx, setSizePx] = useState(0);
  const [hover, setHover] = useState<Point | null>(null);
  const [focused, setFocused] = useState(false);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [cursor, setCursor] = useState<Point>({
    row: Math.floor(size / 2),
    col: Math.floor(size / 2),
  });

  const cursorClamped: Point = {
    row: Math.min(Math.max(cursor.row, 0), size - 1),
    col: Math.min(Math.max(cursor.col, 0), size - 1),
  };

  const isEmpty = useCallback(
    (row: number, col: number): boolean => stoneColorAt(board, row, col) === null,
    [board],
  );

  // 自适应尺寸（含 DPR），监听容器变化
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0].contentRect.width);
      if (width > 0) setSizePx((previous) => (previous === width ? previous : width));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // 离屏画布初始化
  useEffect(() => {
    baseCanvasRef.current = document.createElement('canvas');
    stonesCanvasRef.current = document.createElement('canvas');
  }, []);

  // 核心绘制：更新动画起点 → 画棋子层 → 合成可见层
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || sizePx <= 0) return undefined;

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const pixelSize = Math.round(sizePx * dpr);
    const scale = pixelSize / dimension;
    const canvasCtx = canvas.getContext('2d');
    const baseCanvas = baseCanvasRef.current;
    const stonesCanvas = stonesCanvasRef.current;
    if (!canvasCtx || !baseCanvas || !stonesCanvas) return undefined;

    for (const target of [canvas, baseCanvas, stonesCanvas]) {
      if (target.width !== pixelSize) {
        target.width = pixelSize;
        target.height = pixelSize;
      }
    }

    const baseCtx = baseCanvas.getContext('2d');
    const stonesCtx = stonesCanvas.getContext('2d');
    if (!baseCtx || !stonesCtx) return undefined;

    // 静态层只在尺寸/棋盘路数变化时重绘
    const baseKey = `${pixelSize}:${size}`;
    const baseChanged = baseKeyRef.current !== baseKey;
    if (baseChanged) {
      baseCtx.setTransform(1, 0, 0, 1, 0, 0);
      baseCtx.clearRect(0, 0, pixelSize, pixelSize);
      baseCtx.setTransform(scale, 0, 0, scale, 0, 0);
      paintBase(baseCtx, size);
      baseKeyRef.current = baseKey;
    }

    const anim = animRef.current;
    const lastMove = game.lastMove;
    const winLine = game.winLine;

    const syncAnimations = (now: number): void => {
      const lastKey = lastMove ? `${lastMove.row}:${lastMove.col}:${game.moves.length}` : null;
      if (anim.lastKey !== lastKey) {
        anim.lastKey = lastKey;
        anim.lastStart = now;
      }
      const winKey = winLine && winLine.length >= 2 ? `${game.moves.length}:${winLine[0].row}:${winLine[0].col}` : null;
      if (anim.winKey !== winKey) {
        anim.winKey = winKey;
        anim.winStart = now;
      }
      const pendingKey = pendingMove ? `${pendingMove.row}:${pendingMove.col}` : null;
      if (anim.pendingKey !== pendingKey) {
        anim.pendingKey = pendingKey;
        anim.pendingStart = now;
      }
    };

    const drawStonesLayer = (now: number): void => {
      syncAnimations(now);
      stonesCtx.setTransform(1, 0, 0, 1, 0, 0);
      stonesCtx.clearRect(0, 0, pixelSize, pixelSize);
      stonesCtx.setTransform(scale, 0, 0, scale, 0, 0);

      for (let row = 0; row < size; row += 1) {
        for (let col = 0; col < size; col += 1) {
          const color = stoneColorAt(board, row, col);
          if (!color) continue;
          const cx = PAD + col * CELL;
          const cy = PAD + row * CELL;
          const isLast = lastMove?.row === row && lastMove?.col === col;
          let stoneScale = 1;
          let stoneAlpha = 1;
          if (isLast) {
            const progress = clamp01((now - anim.lastStart) / DROP_MS);
            const eased = easeOutCubic(progress);
            stoneScale = 0.7 + 0.3 * eased + Math.sin(progress * Math.PI) * 0.06;
            stoneAlpha = 0.35 + 0.65 * eased;
          }
          drawStoneSprite(stonesCtx, color, cx, cy, stoneScale, stoneAlpha);
        }
      }

      // 乐观落子（半透明、带落下动画）
      if (pendingMove && myColor && stoneColorAt(board, pendingMove.row, pendingMove.col) === null) {
        const progress = clamp01((now - anim.pendingStart) / DROP_MS);
        const eased = easeOutCubic(progress);
        drawStoneSprite(
          stonesCtx,
          myColor,
          PAD + pendingMove.col * CELL,
          PAD + pendingMove.row * CELL,
          0.8 + 0.2 * eased,
          0.42 + 0.2 * eased,
        );
      }

      // 最后一手涟漪 + 标记
      if (lastMove && stoneColorAt(board, lastMove.row, lastMove.col)) {
        const cx = PAD + lastMove.col * CELL;
        const cy = PAD + lastMove.row * CELL;
        const ripple = clamp01((now - anim.lastStart) / RIPPLE_MS);
        if (ripple < 1) {
          stonesCtx.save();
          stonesCtx.strokeStyle = `rgba(255, 224, 164, ${0.7 * (1 - ripple)})`;
          stonesCtx.lineWidth = 1.8;
          stonesCtx.beginPath();
          stonesCtx.arc(cx, cy, STONE_RADIUS * (1 + 0.9 * ripple), 0, Math.PI * 2);
          stonesCtx.stroke();
          stonesCtx.restore();
        }
        const markProgress = clamp01((now - anim.lastStart) / (DROP_MS * 1.4));
        if (markProgress > 0.25) {
          stonesCtx.save();
          stonesCtx.globalAlpha = Math.min(1, (markProgress - 0.25) / 0.4);
          stonesCtx.fillStyle = '#ffd883';
          stonesCtx.strokeStyle = 'rgba(74, 40, 4, 0.7)';
          stonesCtx.lineWidth = 1.4;
          stonesCtx.beginPath();
          stonesCtx.arc(cx, cy, 5, 0, Math.PI * 2);
          stonesCtx.fill();
          stonesCtx.stroke();
          stonesCtx.restore();
        }
      }

      // 胜线 + 高亮环
      if (winLine && winLine.length >= 2) {
        const progress = easeOutCubic(clamp01((now - anim.winStart) / WIN_MS));
        const start = winLine[0];
        const end = winLine[winLine.length - 1];
        const x1 = PAD + start.col * CELL;
        const y1 = PAD + start.row * CELL;
        const x2 = PAD + end.col * CELL;
        const y2 = PAD + end.row * CELL;
        stonesCtx.save();
        const gradient = stonesCtx.createLinearGradient(x1, y1, x2, y2);
        gradient.addColorStop(0, '#ffd98a');
        gradient.addColorStop(1, '#ff9d5c');
        stonesCtx.strokeStyle = gradient;
        stonesCtx.lineWidth = 7;
        stonesCtx.lineCap = 'round';
        stonesCtx.shadowColor = 'rgba(255, 201, 120, 0.8)';
        stonesCtx.shadowBlur = 10;
        stonesCtx.globalAlpha = 0.85;
        stonesCtx.beginPath();
        stonesCtx.moveTo(x1, y1);
        stonesCtx.lineTo(x1 + (x2 - x1) * progress, y1 + (y2 - y1) * progress);
        stonesCtx.stroke();
        stonesCtx.restore();

        if (progress > 0.45) {
          const ringAlpha = Math.min(1, (progress - 0.45) / 0.4);
          stonesCtx.save();
          stonesCtx.strokeStyle = `rgba(255, 228, 171, ${ringAlpha})`;
          stonesCtx.lineWidth = 2.4;
          stonesCtx.shadowColor = 'rgba(255, 205, 130, 0.9)';
          stonesCtx.shadowBlur = 8;
          for (const point of winLine) {
            stonesCtx.beginPath();
            stonesCtx.arc(
              PAD + point.col * CELL,
              PAD + point.row * CELL,
              STONE_RADIUS + 2.6,
              0,
              Math.PI * 2,
            );
            stonesCtx.stroke();
          }
          stonesCtx.restore();
        }
      }
    };

    const drawComposite = (): void => {
      canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
      canvasCtx.clearRect(0, 0, pixelSize, pixelSize);
      canvasCtx.drawImage(baseCanvas, 0, 0);
      canvasCtx.drawImage(stonesCanvas, 0, 0);
      canvasCtx.setTransform(scale, 0, 0, scale, 0, 0);

      // 悬停虚影
      if (interactive && hover && myColor && stoneColorAt(board, hover.row, hover.col) === null) {
        const cx = PAD + hover.col * CELL;
        const cy = PAD + hover.row * CELL;
        drawStoneSprite(canvasCtx, myColor, cx, cy, 1, 0.5);
        canvasCtx.save();
        canvasCtx.strokeStyle = 'rgba(255, 248, 231, 0.55)';
        canvasCtx.lineWidth = 1.3;
        canvasCtx.setLineDash([4, 3]);
        canvasCtx.beginPath();
        canvasCtx.arc(cx, cy, STONE_RADIUS + 2.4, 0, Math.PI * 2);
        canvasCtx.stroke();
        canvasCtx.restore();
      }

      // 键盘光标
      if (focused && keyboardNav) {
        const x = PAD + cursorClamped.col * CELL;
        const y = PAD + cursorClamped.row * CELL;
        canvasCtx.save();
        canvasCtx.strokeStyle = 'rgba(255, 246, 224, 0.9)';
        canvasCtx.lineWidth = 2;
        canvasCtx.setLineDash([5, 4]);
        canvasCtx.beginPath();
        const half = STONE_RADIUS + 4;
        canvasCtx.roundRect(x - half, y - half, half * 2, half * 2, 7);
        canvasCtx.stroke();
        canvasCtx.restore();
      }
    };

    const isAnimating = (now: number): boolean => {
      if (anim.lastKey && now - anim.lastStart < RIPPLE_MS) return true;
      if (anim.winKey && now - anim.winStart < WIN_MS) return true;
      if (anim.pendingKey && now - anim.pendingStart < DROP_MS) return true;
      return false;
    };

    const boardChanged = boardRef.current !== board;
    boardRef.current = board;
    const stonesKey = `${game.moves.length}:${lastMove?.row ?? -1},${lastMove?.col ?? -1}:${
      pendingMove?.row ?? -1
    },${pendingMove?.col ?? -1}:${myColor ?? '-'}:${winLine?.length ?? 0}`;
    const stonesChanged = boardChanged || baseChanged || stonesKeyRef.current !== stonesKey;
    stonesKeyRef.current = stonesKey;

    const render = (now: number): void => {
      // 悬停/键盘光标变化只重合成；棋子层仅在棋谱变化或动画期间重绘
      if (stonesChanged || isAnimating(now)) {
        drawStonesLayer(now);
      }
      drawComposite();
    };

    renderRef.current = render;
    animatingRef.current = isAnimating;

    const loop = (now: number): void => {
      rafRef.current = null;
      render(now);
      if (isAnimating(now)) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };

    const now = performance.now();
    render(now);
    if (isAnimating(now)) {
      rafRef.current = requestAnimationFrame(loop);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [
    size,
    dimension,
    sizePx,
    board,
    game.lastMove,
    game.winLine,
    game.moves.length,
    pendingMove,
    myColor,
    interactive,
    hover,
    focused,
    keyboardNav,
    cursorClamped.row,
    cursorClamped.col,
  ]);

  const pointFromEvent = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const x = ((clientX - rect.left) / rect.width) * dimension;
      const y = ((clientY - rect.top) / rect.height) * dimension;
      const col = Math.round((x - PAD) / CELL);
      const row = Math.round((y - PAD) / CELL);
      if (row < 0 || row >= size || col < 0 || col >= size) return null;
      const offsetX = Math.abs(x - (PAD + col * CELL));
      const offsetY = Math.abs(y - (PAD + row * CELL));
      if (offsetX > CELL * 0.48 || offsetY > CELL * 0.48) return null;
      return { row, col };
    },
    [dimension, size],
  );

  const place = useCallback(
    (point: Point): void => {
      if (!interactive) return;
      if (!isEmpty(point.row, point.col)) return;
      onMove(point.row, point.col);
    },
    [interactive, isEmpty, onMove],
  );

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive) {
      if (hover) setHover(null);
      return;
    }
    const point = pointFromEvent(event.clientX, event.clientY);
    const next = point && isEmpty(point.row, point.col) ? point : null;
    setHover((previous) => {
      if (previous === null && next === null) return previous;
      if (previous && next && previous.row === next.row && previous.col === next.col) return previous;
      return next;
    });
  };

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    const point = pointFromEvent(event.clientX, event.clientY);
    if (point) place(point);
  };

  const moveCursor = (deltaRow: number, deltaCol: number): void => {
    setCursor((previous) => ({
      row: Math.min(Math.max(previous.row + deltaRow, 0), size - 1),
      col: Math.min(Math.max(previous.col + deltaCol, 0), size - 1),
    }));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        setKeyboardNav(true);
        moveCursor(-1, 0);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setKeyboardNav(true);
        moveCursor(1, 0);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        setKeyboardNav(true);
        moveCursor(0, -1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        setKeyboardNav(true);
        moveCursor(0, 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (keyboardNav) place(cursorClamped);
        break;
      default:
        break;
    }
  };

  const winnerText = game.winner
    ? `${game.winner === 'black' ? '黑方' : '白方'}获胜`
    : game.endedReason === 'draw'
      ? '和棋'
      : '';

  return (
    <div
      className={`board-frame${focused ? ' is-focused' : ''}${interactive ? ' is-interactive' : ''}`}
      ref={frameRef}
      tabIndex={0}
      role="application"
      aria-label="五子棋棋盘：方向键移动光标，回车落子"
      aria-disabled={!interactive}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        setFocused(true);
        setKeyboardNav(frameRef.current?.matches(':focus-visible') ?? false);
      }}
      onBlur={() => {
        setFocused(false);
        setKeyboardNav(false);
        setHover(null);
      }}
      onPointerDown={() => {
        setKeyboardNav(false);
        frameRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="board-surface">
        <div
          className="board-canvas-wrap"
          ref={wrapRef}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHover(null)}
          onClick={handleClick}
        >
          <canvas ref={canvasRef} className="board-canvas" aria-hidden="true" />
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        共 {game.moves.length} 手{winnerText ? `，${winnerText}` : ''}
      </span>
    </div>
  );
}

export const Board = memo(BoardComponent);
Board.displayName = 'Board';
