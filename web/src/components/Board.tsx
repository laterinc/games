import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Color, Game, Point } from '../types';

interface BoardProps {
  game: Game;
  /** 我的执子颜色；null 表示没有可操作的颜色。 */
  myColor: Color | null;
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

function stoneColorAt(board: number[][], row: number, col: number): Color | null {
  const cell = board[row]?.[col] ?? 0;
  if (cell === 1) return 'black';
  if (cell === 2) return 'white';
  return null;
}

/**
 * 15 路（按 game.boardSize 自适应）棋盘。
 * 支持鼠标/触摸落子、悬停虚影、最后一手标记、胜线高亮，以及方向键 + Enter 键盘落子。
 */
function StoneShape({ color, cx, cy }: { color: Color; cx: number; cy: number }) {
  return (
    <>
      <circle
        cx={cx}
        cy={cy}
        r={STONE_RADIUS}
        fill={`url(#stone-${color})`}
        stroke={color === 'white' ? 'rgba(120, 132, 145, 0.55)' : 'rgba(0, 0, 0, 0.6)'}
        strokeWidth={color === 'white' ? 0.8 : 0.6}
      />
      <ellipse
        cx={cx - 5.4}
        cy={cy - 6.2}
        rx={6.2}
        ry={3.4}
        fill={color === 'white' ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.34)'}
        transform={`rotate(-26 ${cx - 5.4} ${cy - 6.2})`}
      />
    </>
  );
}

function BoardComponent({ game, myColor, interactive, pendingMove, onMove }: BoardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const size = clampBoardSize(game.boardSize);
  const dimension = (size - 1) * CELL + PAD * 2;
  const board = game.board;
  const stars = useMemo(() => starPoints(size), [size]);

  const [hover, setHover] = useState<Point | null>(null);
  const [focused, setFocused] = useState(false);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [cursor, setCursor] = useState<Point>({ row: Math.floor(size / 2), col: Math.floor(size / 2) });

  const cursorClamped: Point = {
    row: Math.min(Math.max(cursor.row, 0), size - 1),
    col: Math.min(Math.max(cursor.col, 0), size - 1),
  };

  const isEmpty = useCallback(
    (row: number, col: number): boolean => stoneColorAt(board, row, col) === null,
    [board],
  );

  const pointFromEvent = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
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

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
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

  const handlePointerLeave = (): void => {
    setHover(null);
  };

  const handleClick = (event: ReactMouseEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    const point = pointFromEvent(event.clientX, event.clientY);
    if (!point) return;
    place(point);
  };

  const moveCursor = (deltaRow: number, deltaCol: number): void => {
    setCursor((previous) => {
      const base = {
        row: Math.min(Math.max(previous.row, 0), size - 1),
        col: Math.min(Math.max(previous.col, 0), size - 1),
      };
      return {
        row: Math.min(Math.max(base.row + deltaRow, 0), size - 1),
        col: Math.min(Math.max(base.col + deltaCol, 0), size - 1),
      };
    });
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

  const winLine = game.winLine ?? [];
  const winKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const point of winLine) {
      if (point.row >= 0 && point.col >= 0 && point.row < size && point.col < size) {
        keys.add(`${point.row}:${point.col}`);
      }
    }
    return keys;
  }, [winLine, size]);

  const winStart = winLine[0];
  const winEnd = winLine[winLine.length - 1];

  const cursorX = PAD + cursorClamped.col * CELL;
  const cursorY = PAD + cursorClamped.row * CELL;
  const ghostColor = myColor === 'white' ? 'rgba(248, 250, 252, 0.62)' : 'rgba(16, 20, 26, 0.55)';

  // 静态网格/坐标/星位与棋子分层缓存：悬停、光标、音频等状态变化时不重复构建 200+ 个节点
  const gridLayer = useMemo(() => {
    const end = PAD + (size - 1) * CELL;
    return Array.from({ length: size }, (_, index) => {
      const pos = PAD + index * CELL;
      return (
        <g key={`grid-${index}`}>
          <line className="board-line" x1={PAD} y1={pos} x2={end} y2={pos} />
          <line className="board-line" x1={pos} y1={PAD} x2={pos} y2={end} />
        </g>
      );
    });
  }, [size]);

  const coordLayer = useMemo(
    () =>
      Array.from({ length: size }, (_, index) => (
        <g key={`coord-${index}`} className="board-coord">
          <text x={PAD + index * CELL} y={PAD - 17} textAnchor="middle">
            {String.fromCharCode(65 + index)}
          </text>
          <text x={PAD - 18} y={PAD + index * CELL + 4} textAnchor="middle">
            {index + 1}
          </text>
        </g>
      )),
    [size],
  );

  const starLayer = useMemo(
    () =>
      stars.map((point) => (
        <circle
          key={`star-${point.row}-${point.col}`}
          className="board-star"
          cx={PAD + point.col * CELL}
          cy={PAD + point.row * CELL}
          r={3.4}
        />
      )),
    [stars],
  );

  const stoneLayer = useMemo(
    () =>
      Array.from({ length: size }, (_, row) =>
        Array.from({ length: size }, (_, col) => {
          const color = stoneColorAt(board, row, col);
          if (!color) return null;
          const cx = PAD + col * CELL;
          const cy = PAD + row * CELL;
          const isLast = game.lastMove?.row === row && game.lastMove?.col === col;
          return (
            <g
              key={`stone-${row}-${col}`}
              className={`stone-group${isLast ? ' is-last' : ''}`}
              filter="url(#stone-shadow)"
            >
              <StoneShape color={color} cx={cx} cy={cy} />
            </g>
          );
        }),
      ),
    [size, board, game.lastMove],
  );

  return (
    <div
      className={`board-frame${focused ? ' is-focused' : ''}${interactive ? ' is-interactive' : ''}`}
      ref={wrapperRef}
      tabIndex={0}
      role="application"
      aria-label="五子棋棋盘：方向键移动光标，回车落子"
      aria-disabled={!interactive}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        setFocused(true);
        setKeyboardNav(wrapperRef.current?.matches(':focus-visible') ?? false);
      }}
      onBlur={() => {
        setFocused(false);
        setKeyboardNav(false);
        setHover(null);
      }}
      onPointerDown={() => {
        setKeyboardNav(false);
        wrapperRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="board-surface">
        <svg
          ref={svgRef}
          className="board-svg"
          viewBox={`0 0 ${dimension} ${dimension}`}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onClick={handleClick}
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="stone-black" cx="34%" cy="28%" r="78%">
              <stop offset="0%" stopColor="#7b8492" />
              <stop offset="32%" stopColor="#3a4049" />
              <stop offset="72%" stopColor="#1b1f25" />
              <stop offset="100%" stopColor="#05070a" />
            </radialGradient>
            <radialGradient id="stone-white" cx="34%" cy="26%" r="80%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="46%" stopColor="#f2f4f7" />
              <stop offset="82%" stopColor="#d8dee5" />
              <stop offset="100%" stopColor="#aeb8c2" />
            </radialGradient>
            <linearGradient id="win-line-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ffd98a" />
              <stop offset="100%" stopColor="#ff9d5c" />
            </linearGradient>
            <filter id="stone-shadow" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="2.6" stdDeviation="2.4" floodColor="#1d1206" floodOpacity="0.55" />
            </filter>
          </defs>

          {/* 木纹由 .board-surface 的 CSS 渐变提供，这里只画线与星位 */}
          {gridLayer}
          {coordLayer}
          {starLayer}

          {winStart && winEnd && winLine.length >= 2 ? (
            <line
              className="win-line"
              x1={PAD + winStart.col * CELL}
              y1={PAD + winStart.row * CELL}
              x2={PAD + winEnd.col * CELL}
              y2={PAD + winEnd.row * CELL}
            />
          ) : null}

          {/* 棋子（最后一手带落下动画） */}
          {stoneLayer}

          {/* 乐观落子：点击后立即出现半透明棋子，不等服务端广播 */}
          {pendingMove &&
          myColor &&
          stoneColorAt(board, pendingMove.row, pendingMove.col) === null ? (
            <g
              className="stone-optimistic"
              filter="url(#stone-shadow)"
              aria-hidden="true"
            >
              <StoneShape
                color={myColor}
                cx={PAD + pendingMove.col * CELL}
                cy={PAD + pendingMove.row * CELL}
              />
            </g>
          ) : null}

          {/* 最后一手标记 */}
          {game.lastMove &&
          game.lastMove.row >= 0 &&
          game.lastMove.row < size &&
          game.lastMove.col >= 0 &&
          game.lastMove.col < size &&
          stoneColorAt(board, game.lastMove.row, game.lastMove.col) ? (
            <g key={`last-${game.lastMove.row}-${game.lastMove.col}`}>
              <circle
                className="stone-ripple"
                cx={PAD + game.lastMove.col * CELL}
                cy={PAD + game.lastMove.row * CELL}
                r={STONE_RADIUS}
              />
              <circle
                className="last-move-mark"
                cx={PAD + game.lastMove.col * CELL}
                cy={PAD + game.lastMove.row * CELL}
                r={5}
              />
            </g>
          ) : null}

          {/* 胜线棋子高亮环 */}
          {Array.from(winKeys).map((key) => {
            const [row, col] = key.split(':').map((value) => Number(value));
            return (
              <circle
                key={`win-${key}`}
                className="win-ring"
                cx={PAD + col * CELL}
                cy={PAD + row * CELL}
                r={STONE_RADIUS + 2.6}
              />
            );
          })}

          {/* 悬停虚影（只画在空交叉点上） */}
          {hover && isEmpty(hover.row, hover.col) ? (
            <circle
              className="ghost-stone"
              cx={PAD + hover.col * CELL}
              cy={PAD + hover.row * CELL}
              r={STONE_RADIUS}
              fill={ghostColor}
            />
          ) : null}

          {/* 键盘光标 */}
          {focused && keyboardNav ? (
            <rect
              className="keyboard-cursor"
              x={cursorX - STONE_RADIUS - 4}
              y={cursorY - STONE_RADIUS - 4}
              width={(STONE_RADIUS + 4) * 2}
              height={(STONE_RADIUS + 4) * 2}
              rx={7}
            />
          ) : null}
        </svg>
      </div>
    </div>
  );
}

export const Board = memo(BoardComponent);
Board.displayName = 'Board';
