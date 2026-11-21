import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, Color, Point, Room, ToastLevel } from '../types';
import type { SocketStatus } from '../lib/socket';
import { COLOR_LABEL, ROOM_STATUS_LABEL } from '../lib/protocol';
import { isSoundEnabled, playResultSound, playStoneSound, setSoundEnabled, unlockAudio } from '../lib/sound';
import { copyText } from '../lib/clipboard';
import { Board } from './Board';
import { ChatPanel } from './ChatPanel';
import { Modal } from './Modal';
import { PlayerCard } from './PlayerCard';

interface RoomViewProps {
  room: Room;
  status: SocketStatus;
  playerId: string | null;
  isSpectator: boolean;
  chat: ChatMessage[];
  onMove: (row: number, col: number) => void;
  onReady: () => void;
  onRematch: () => void;
  onResign: () => void;
  onUndo: () => void;
  onUndoResponse: (accept: boolean) => void;
  onLeave: () => void;
  onChat: (text: string) => void;
  notify: (text: string, level?: ToastLevel) => void;
}

interface ResultInfo {
  title: string;
  detail: string;
  tone: Color | 'draw' | 'neutral';
}

function describeResult(room: Room): ResultInfo | null {
  if (room.status !== 'finished') return null;
  const { winner, endedReason } = room.game;
  if (endedReason === 'forfeit') {
    return {
      title: winner ? `${COLOR_LABEL[winner]}胜` : '对局结束',
      detail: '对手离开，本局按弃权结算',
      tone: winner ?? 'neutral',
    };
  }
  if (endedReason === 'resign') {
    return {
      title: winner ? `${COLOR_LABEL[winner]}胜` : '对局结束',
      detail: '对方认输',
      tone: winner ?? 'neutral',
    };
  }
  if (winner) {
    return { title: `${COLOR_LABEL[winner]}胜`, detail: '五连达成', tone: winner };
  }
  if (endedReason === 'draw') {
    return { title: '和棋', detail: '棋盘已下满，未分胜负', tone: 'draw' };
  }
  return { title: '对局结束', detail: '', tone: 'neutral' };
}

function IconSound({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="btn-svg">
      <path
        d="M4 9.5v5h3.2L12 18V6L7.2 9.5H4Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {muted ? (
        <path d="m16 9 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      ) : (
        <>
          <path d="M15.5 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M18 6.5a8 8 0 0 1 0 11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** 对局页：棋盘、双方信息、回合/手数、准备/再来一局、邀请与聊天。 */
export function RoomView({
  room,
  status,
  playerId,
  isSpectator,
  chat,
  onMove,
  onReady,
  onRematch,
  onResign,
  onUndo,
  onUndoResponse,
  onLeave,
  onChat,
  notify,
}: RoomViewProps) {
  const connected = status === 'open';
  const spectator = isSpectator;
  const players = room.players;
  const me = playerId ? players.find((player) => player.id === playerId) ?? null : null;
  const opponent = playerId ? players.find((player) => player.id !== playerId) ?? null : null;
  const blackSeat = players.find((player) => player.color === 'black') ?? null;
  const whiteSeat = players.find((player) => player.color === 'white') ?? null;
  const myColor = me?.color ?? null;
  const game = room.game;
  const myTurn =
    connected && room.status === 'playing' && myColor !== null && game.currentTurn === myColor;
  const isAiRoom = room.mode === 'ai';
  const botPlayer = players.find((player) => player.isBot) ?? null;
  const botThinking = room.status === 'playing' && botPlayer?.color === game.currentTurn;
  const undoRequest = room.pendingUndo;
  const iRequestedUndo = undoRequest !== null && undoRequest.playerId === playerId;
  const opponentRequestedUndo = undoRequest !== null && undoRequest.playerId !== playerId;
  const canUndo =
    !spectator && connected && room.status === 'playing' && game.moves.length > 0 && undoRequest === null;

  const [pendingMove, setPendingMove] = useState<Point | null>(null);
  const pending = pendingMove !== null;
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [resignOpen, setResignOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(isSoundEnabled());
  const ownPendingRef = useRef<Point | null>(null);
  const prevMovesRef = useRef(game.moves.length);
  const prevStatusRef = useRef(room.status);

  // 服务端广播的棋谱一旦变化，说明落子已被确认（或已被拒绝/撤销）。
  useEffect(() => {
    setPendingMove(null);
  }, [game.moves.length, room.status, room.id]);

  useEffect(() => {
    if (!pendingMove) return undefined;
    const timer = window.setTimeout(() => setPendingMove(null), 2500);
    return () => window.clearTimeout(timer);
  }, [pendingMove]);

  // 音效：别人/AI 落子时播放；自己的落子已在点击时播过
  useEffect(() => {
    const previous = prevMovesRef.current;
    const next = game.moves.length;
    const lastMove = next > 0 ? game.moves[next - 1] : null;
    if (next > previous && lastMove) {
      const own = ownPendingRef.current;
      const confirmedOwn =
        own !== null && lastMove.row === own.row && lastMove.col === own.col;
      if (!confirmedOwn) {
        playStoneSound(lastMove.color);
      }
      ownPendingRef.current = null;
    } else if (next < previous) {
      ownPendingRef.current = null;
    }
    prevMovesRef.current = next;
  }, [game.moves]);

  useEffect(() => {
    if (room.status === 'finished' && prevStatusRef.current !== 'finished') {
      if (game.winner === null || spectator || myColor === null) {
        playResultSound('draw');
      } else {
        playResultSound(game.winner === myColor ? 'win' : 'loss');
      }
    }
    prevStatusRef.current = room.status;
  }, [room.status, game.winner, myColor, spectator]);

  const interactive = myTurn && !pending;

  const handleMove = useCallback(
    (row: number, col: number): void => {
      if (!interactive) return;
      // 乐观落子：先立刻显示半透明棋子，等服务端快照回来再替换为正式棋子
      ownPendingRef.current = { row, col };
      setPendingMove({ row, col });
      if (myColor) playStoneSound(myColor);
      onMove(row, col);
    },
    [interactive, myColor, onMove],
  );

  const toggleSound = (): void => {
    const next = !soundOn;
    setSoundEnabled(next);
    setSoundOn(next);
    if (next) unlockAudio();
  };

  const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${room.id}`;

  const copyInvite = async (): Promise<void> => {
    const copied = await copyText(inviteUrl);
    notify(copied ? '邀请链接已复制' : '复制失败，请手动复制链接', copied ? 'success' : 'error');
  };

  const copyCode = async (): Promise<void> => {
    const copied = await copyText(room.id);
    notify(copied ? `房间码 ${room.id} 已复制` : '复制失败，请手动复制房间码', copied ? 'success' : 'error');
  };

  const requestLeave = (): void => {
    if (spectator) {
      onLeave();
      return;
    }
    if (room.status === 'playing') {
      setLeaveOpen(true);
      return;
    }
    onLeave();
  };

  const result = describeResult(room);
  const readyCount = players.filter((player) => player.ready).length;
  const rematchVotes = room.rematchVotes;
  const iVotedRematch = playerId !== null && rematchVotes.includes(playerId);
  const votingNames = players
    .filter((player) => rematchVotes.includes(player.id))
    .map((player) => player.name)
    .join('、');

  const turnLabel = pending
    ? '落子确认中…'
    : room.status === 'playing'
      ? myTurn
        ? '轮到你落子'
        : botThinking
          ? '电脑思考中…'
          : `等待${COLOR_LABEL[game.currentTurn]}落子`
      : '';

  return (
    <section className="room-view">
      <header className="room-header card glass">
        <div className="room-title-group">
          <h1 className="room-title">{room.name}</h1>
          <div className="room-sub">
            <span className={`pill pill-${room.status}`}>{ROOM_STATUS_LABEL[room.status]}</span>
            <span className="room-code-chip">
              房间码 <strong>{room.id}</strong>
            </span>
            <button type="button" className="btn btn-ghost btn-tiny" onClick={copyCode}>
              复制房间码
            </button>
            <button type="button" className="btn btn-ghost btn-tiny" onClick={copyInvite}>
              复制邀请链接
            </button>
            {room.visibility === 'private' ? <span className="badge badge-private">私密</span> : null}
            {spectator ? <span className="badge badge-spectator">观战中</span> : null}
          </div>
        </div>
        <div className="room-header-actions">
          <button
            type="button"
            className="btn btn-ghost btn-tiny sound-toggle"
            onClick={toggleSound}
            aria-label={soundOn ? '关闭音效' : '开启音效'}
            title={soundOn ? '关闭音效' : '开启音效'}
            aria-pressed={soundOn}
          >
            <IconSound muted={!soundOn} />
          </button>
          <span className={`conn-chip${connected ? ' is-online' : ' is-offline'}`}>
            <span className="online-dot" aria-hidden="true" />
            {connected ? '已连接' : '重连中'}
          </span>
          <button type="button" className="btn btn-ghost btn-small danger" onClick={requestLeave}>
            {spectator ? '退出观战' : '离开房间'}
          </button>
        </div>
      </header>

      <div className="room-grid">
        <div className="board-panel card glass">
          <div className="turn-bar">
            {room.status === 'playing' ? (
              <>
                <span className={`turn-dot turn-${game.currentTurn}`} aria-hidden="true" />
                <span className={`turn-text${myTurn && !pending ? ' is-my-turn' : ''}`}>
                  {turnLabel}
                </span>
                <span className="turn-meta">手数 {game.moves.length}</span>
              </>
            ) : room.status === 'waiting' ? (
              <>
                <span className="turn-dot turn-waiting" aria-hidden="true" />
                <span className="turn-text">
                  {players.length < 2 ? '等待对手加入…' : me?.ready ? '已准备，等待对手' : '双方准备后开局'}
                </span>
                <span className="turn-meta">
                  已准备 {readyCount}/{players.length}
                </span>
              </>
            ) : (
              <>
                <span className="turn-dot turn-finished" aria-hidden="true" />
                <span className="turn-text">对局结束</span>
                <span className="turn-meta">手数 {game.moves.length}</span>
              </>
            )}
          </div>

          {result ? (
            <div className={`result-banner tone-${result.tone}`} role="status">
              <span className="result-title">{result.title}</span>
              {result.detail ? <span className="result-detail">{result.detail}</span> : null}
              <span className="result-hint">
                {spectator ? '观战中' : isAiRoom ? '可在右侧再来一局' : '可在右侧投票再来一局'}
              </span>
            </div>
          ) : null}

          <div className="board-stage">
            <Board
              game={game}
              myColor={myColor}
              interactive={interactive}
              pendingMove={pendingMove}
              onMove={handleMove}
            />
          </div>

          <div className="board-footer">
            <span>黑棋先行 · 五连获胜</span>
            <span>{spectator ? '观战中 · 只读' : myColor ? `你执${COLOR_LABEL[myColor]}` : '未入座'}</span>
          </div>
        </div>

        <aside className="room-side">
          <div className="card glass players-card">
            <PlayerCard
              player={blackSeat}
              seatColor="black"
              isMe={blackSeat !== null && blackSeat.id === playerId}
            />
            <div className="vs-divider" aria-hidden="true">
              VS
            </div>
            <PlayerCard
              player={whiteSeat}
              seatColor="white"
              isMe={whiteSeat !== null && whiteSeat.id === playerId}
            />
            {room.spectators > 0 ? (
              <p className="spectator-count">{room.spectators} 人正在观战</p>
            ) : null}
            {opponent && !opponent.connected ? (
              <p className="hint-warn">对手掉线，60 秒内未重连将按离开处理。</p>
            ) : null}
          </div>

          <div className="card glass room-actions-card">
            {spectator ? (
              <>
                <p className="action-title">观战中</p>
                <p className="action-hint">你正在只读观看本局，无法落子、准备或投票。</p>
              </>
            ) : room.status === 'waiting' ? (
              <>
                <p className="action-title">
                  {players.length < 2 ? '等待对手加入' : me?.ready ? '已准备，等待对手' : '双方准备后开局'}
                </p>
                <button
                  type="button"
                  className={`btn btn-block ${me?.ready ? 'btn-ghost' : 'btn-primary'}`}
                  onClick={onReady}
                  disabled={!connected || !me}
                >
                  {me?.ready ? '取消准备' : '准备'}
                </button>
                <p className="action-hint">把邀请链接发给好友，或等待大厅玩家加入。</p>
              </>
            ) : room.status === 'finished' ? (
              isAiRoom ? (
                <>
                  <p className="action-title">人机对战结束</p>
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    onClick={onRematch}
                    disabled={!connected}
                  >
                    再来一局
                  </button>
                  <p className="action-hint">与电脑再战一局，自动交换黑白。</p>
                </>
              ) : (
                <>
                  <p className="action-title">再来一局（{rematchVotes.length}/2）</p>
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    onClick={onRematch}
                    disabled={!connected || iVotedRematch}
                  >
                    {iVotedRematch ? '已投票，等待对手' : '再来一局'}
                  </button>
                  {votingNames ? <p className="action-hint">{votingNames} 已投票</p> : null}
                  <p className="action-hint">双方都投票后自动重开，并交换黑白。</p>
                </>
              )
            ) : (
              <>
                <p className="action-title">
                  {myTurn ? '轮到你落子' : botThinking ? '电脑思考中…' : '等待对手落子'}
                </p>
                <p className="action-hint">
                  {pending ? '已提交落子，等待服务端确认…' : '点击棋盘交叉点落子，仅轮到你时可下。'}
                </p>
                {opponentRequestedUndo ? (
                  <div className="undo-panel">
                    <p className="action-title">{undoRequest?.name ?? '对方'} 请求悔棋</p>
                    <div className="action-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => onUndoResponse(true)}
                        disabled={!connected}
                      >
                        同意
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => onUndoResponse(false)}
                        disabled={!connected}
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                ) : iRequestedUndo ? (
                  <p className="action-hint">已发送悔棋请求，等待对方回应…</p>
                ) : (
                  <div className="action-row">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={onUndo}
                      disabled={!canUndo}
                    >
                      悔棋
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost danger"
                      onClick={() => setResignOpen(true)}
                      disabled={!connected}
                    >
                      认输
                    </button>
                  </div>
                )}
              </>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-block danger"
              onClick={requestLeave}
              disabled={!connected}
            >
              {spectator ? '退出观战' : '离开房间'}
            </button>
          </div>

          <ChatPanel messages={chat} onSend={onChat} myPlayerId={playerId} disabled={!connected} />
        </aside>
      </div>

      <Modal
        open={resignOpen}
        title="确认认输"
        onClose={() => setResignOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setResignOpen(false)}>
              继续对局
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setResignOpen(false);
                onResign();
              }}
            >
              确认认输
            </button>
          </>
        }
      >
        <p>认输后本局判负，对手获胜。确定要认输吗？</p>
      </Modal>

      <Modal
        open={leaveOpen}
        title="确认离开房间"
        onClose={() => setLeaveOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setLeaveOpen(false)}>
              继续对局
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setLeaveOpen(false);
                onLeave();
              }}
            >
              确认离开
            </button>
          </>
        }
      >
        <p>对局仍在进行中，现在离开将被判负（对手获胜）。确定要离开吗？</p>
      </Modal>
    </section>
  );
}
