import { useEffect, useState, type FormEvent } from 'react';
import type {
  CreateColor,
  GameType,
  MatchRecord,
  RoomSummary,
  RoomVisibility,
  ToastLevel,
} from '../types';
import {
  COLOR_LABEL,
  MAX_NICKNAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  ROOM_STATUS_LABEL,
} from '../lib/protocol';
import { GAME_LABEL, GAMES } from '../games/registry';
import { Modal } from './Modal';

interface LobbyProps {
  nickname: string;
  onNicknameChange: (value: string) => void;
  rooms: RoomSummary[];
  connected: boolean;
  gameType: GameType;
  initialRoomCode: string;
  onQuickMatch: () => void;
  onCreateRoom: (options: {
    roomName: string;
    visibility: RoomVisibility;
    color: CreateColor;
    boardSize?: number;
  }) => void;
  onAiGame: (color: CreateColor, boardSize?: number) => void;
  records: MatchRecord[];
  onJoinRoom: (roomId: string) => void;
  onWatchRoom: (roomId: string) => void;
  onRefreshRooms: () => void;
  notify: (text: string, level?: ToastLevel) => void;
}

const BOARD_SIZE_OPTIONS = [9, 11, 13, 15, 17, 19] as const;
const DEFAULT_GOMOKU_SIZE = 15;

function BoardSizeField({
  value,
  onChange,
}: {
  value: number;
  onChange: (size: number) => void;
}) {
  return (
    <div className="field">
      <span className="field-label">棋盘大小</span>
      <div className="segmented segmented-six" role="group" aria-label="棋盘大小">
        {BOARD_SIZE_OPTIONS.map((size) => (
          <button
            key={size}
            type="button"
            className={`segmented-item${value === size ? ' is-active' : ''}`}
            aria-pressed={value === size}
            onClick={() => onChange(size)}
          >
            <span className="segmented-label">{size} 路</span>
          </button>
        ))}
      </div>
      <span className="field-hint">路数越少棋盘越小、节奏越快；标准 15 路。</span>
    </div>
  );
}

const RECORD_RESULT_LABEL = { win: '胜', loss: '负', draw: '和' } as const;
const END_REASON_LABEL: Record<string, string> = {
  five: '五连',
  draw: '和棋',
  forfeit: '弃权',
  resign: '认输',
  checkmate: '将死',
  stalemate: '困毙',
};

function formatRecordTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function normalizeRoomCode(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 6)
    .toUpperCase();
}

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="btn-svg">
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" fill="currentColor" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="btn-svg">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconBot() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="btn-svg">
      <rect x="4" y="8" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 4v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="9" cy="13" r="1.2" fill="currentColor" />
      <circle cx="15" cy="13" r="1.2" fill="currentColor" />
      <path d="M9.5 16.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="btn-svg">
      <path
        d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconWatch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="btn-svg">
      <path
        d="M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** 大厅：昵称、快速匹配、创建房间、人机对战、公开房间列表、房间码加入、最近战绩。 */
export function Lobby({
  nickname,
  onNicknameChange,
  rooms,
  connected,
  gameType,
  initialRoomCode,
  onQuickMatch,
  onCreateRoom,
  onAiGame,
  records,
  onJoinRoom,
  onWatchRoom,
  onRefreshRooms,
  notify,
}: LobbyProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiColor, setAiColor] = useState<CreateColor>(gameType === 'chess' ? 'red' : 'black');
  const [roomName, setRoomName] = useState('');
  const [visibility, setVisibility] = useState<RoomVisibility>('public');
  const [color, setColor] = useState<CreateColor>(gameType === 'chess' ? 'red' : 'black');
  const [joinCode, setJoinCode] = useState(initialRoomCode);
  const [joinError, setJoinError] = useState('');
  const [boardSize, setBoardSize] = useState<number>(DEFAULT_GOMOKU_SIZE);

  useEffect(() => {
    if (initialRoomCode) setJoinCode(initialRoomCode);
  }, [initialRoomCode]);

  useEffect(() => {
    const defaultColor: CreateColor = gameType === 'chess' ? 'red' : 'black';
    setColor(defaultColor);
    setAiColor(defaultColor);
    setBoardSize(DEFAULT_GOMOKU_SIZE);
  }, [gameType]);

  const trimmedNickname = nickname.trim();
  const nicknameValid =
    trimmedNickname.length >= 1 && trimmedNickname.length <= MAX_NICKNAME_LENGTH;
  const canStart = connected && nicknameValid;
  const roomNameValid = roomName.trim().length <= MAX_ROOM_NAME_LENGTH;
  const joinCodeReady = normalizeRoomCode(joinCode).length === 6;

  const wins = records.filter((record) => record.result === 'win').length;
  const losses = records.filter((record) => record.result === 'loss').length;
  const draws = records.filter((record) => record.result === 'draw').length;
  const visibleRooms = rooms.filter((room) => room.gameType === gameType);
  const meta = GAMES[gameType];
  const options = meta.colorOptions;

  const handleQuickMatch = (): void => {
    if (!canStart) return;
    onQuickMatch();
  };

  const handleCreate = (): void => {
    if (!canStart) return;
    if (!roomNameValid) {
      notify(`房间名最多 ${MAX_ROOM_NAME_LENGTH} 个字符`, 'error');
      return;
    }
    onCreateRoom({
      roomName: roomName.trim(),
      visibility,
      color,
      boardSize: gameType === 'gomoku' ? boardSize : undefined,
    });
    setCreateOpen(false);
  };

  const handleAiStart = (): void => {
    if (!canStart) return;
    onAiGame(aiColor, gameType === 'gomoku' ? boardSize : undefined);
    setAiOpen(false);
  };

  const handleJoin = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const code = normalizeRoomCode(joinCode);
    if (code.length !== 6) {
      setJoinError('请输入 6 位房间码');
      return;
    }
    setJoinError('');
    onJoinRoom(code);
  };

  return (
    <section className="lobby" data-game={gameType}>
      <div className="lobby-hero card glass">
        <div className="hero-intro">
          <span className="hero-eyebrow">
            <span className="live-dot" aria-hidden="true" />
            游戏大厅 · 无需注册
          </span>
          <h1 className="hero-title">开一局，马上开始</h1>
          <p className="hero-sub">{meta.description}</p>

          <div className="hero-tags" aria-hidden="true">
            {meta.tags.map((tag) => (
              <span key={tag} className="hero-tag">
                {tag}
              </span>
            ))}
          </div>

          <div className="hero-field">
            <label className="field">
              <span className="field-label">你的昵称</span>
              <input
                className="input"
                type="text"
                value={nickname}
                maxLength={MAX_NICKNAME_LENGTH}
                placeholder="输入 1–16 个字符的昵称"
                autoComplete="nickname"
                spellCheck={false}
                onChange={(event) => onNicknameChange(event.target.value)}
              />
            </label>
            {!nicknameValid ? (
              <span className="field-hint error">昵称需为 1–{MAX_NICKNAME_LENGTH} 个字符</span>
            ) : (
              <span className="field-hint">昵称会保存在本机，下次自动填入。</span>
            )}
          </div>

          <div className="hero-actions">
            <button
              type="button"
              className="btn btn-primary btn-large"
              onClick={handleQuickMatch}
              disabled={!canStart}
            >
              <IconBolt />
              快速匹配
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-large"
              onClick={() => setCreateOpen(true)}
              disabled={!canStart}
            >
              <IconPlus />
              创建房间
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-large"
              onClick={() => setAiOpen(true)}
              disabled={!canStart}
            >
              <IconBot />
              人机对战
            </button>
          </div>
          {!connected ? <p className="hint-warn">正在连接服务器，连接成功后才能开始对局。</p> : null}
        </div>

        <div className="hero-visual" aria-hidden="true">
          {gameType === 'chess' ? (
            <div className="hero-chess">
              <span className="hero-chess-river">楚河 · 汉界</span>
              <span className="hero-chess-piece red pos-r1">帅</span>
              <span className="hero-chess-piece red pos-r2">车</span>
              <span className="hero-chess-piece red pos-r3">炮</span>
              <span className="hero-chess-piece black pos-b1">将</span>
              <span className="hero-chess-piece black pos-b2">车</span>
              <span className="hero-chess-piece black pos-b3">炮</span>
              <span className="hero-mini-caption">将死 · 胜</span>
            </div>
          ) : (
          <div className="hero-mini">
            <svg className="hero-mini-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="hero-win-gradient" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#ffd98a" stopOpacity="0.1" />
                  <stop offset="45%" stopColor="#ffe3a6" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#ff9d5c" stopOpacity="0.75" />
                </linearGradient>
              </defs>
              <line x1="12" y1="70" x2="76" y2="18" stroke="url(#hero-win-gradient)" strokeWidth="0.9" strokeLinecap="round" />
            </svg>
            <span className="hero-piece stone-black pos-1" />
            <span className="hero-piece stone-black pos-2" />
            <span className="hero-piece stone-black pos-3" />
            <span className="hero-piece stone-black pos-4" />
            <span className="hero-piece stone-black pos-5 is-winning" />
            <span className="hero-piece stone-white pos-w1" />
            <span className="hero-piece stone-white pos-w2" />
            <span className="hero-mini-caption">五子连珠 · 胜</span>
          </div>
          )}
          <p className="hero-visual-note">{meta.note}</p>
        </div>
      </div>

      <div className="lobby-columns">
        <div className="card glass rooms-card">
          <header className="card-header">
            <div>
              <h2>公开房间</h2>
              <p className="card-sub">实时推送 · 按创建时间排序</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={onRefreshRooms}
              disabled={!connected}
            >
              <IconRefresh />
              刷新
            </button>
          </header>

          {visibleRooms.length === 0 ? (
            <div className="room-empty">
              <span className="room-empty-art" aria-hidden="true">
                <span className="empty-stone black" />
                <span className="empty-stone white" />
                <span className="empty-grid" />
              </span>
              <p className="room-empty-title">
                {connected ? `暂无${GAME_LABEL[gameType]}公开房间` : '正在连接服务器…'}
              </p>
              <p className="room-empty-sub">
                {connected
                  ? '创建一个房间邀请好友，或直接快速匹配。'
                  : '连接成功后会自动拉取房间列表。'}
              </p>
              {connected ? (
                <div className="room-empty-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={handleQuickMatch}
                    disabled={!canStart}
                  >
                    <IconBolt />
                    立即匹配
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => setCreateOpen(true)}
                    disabled={!canStart}
                  >
                    <IconPlus />
                    新建房间
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <ul className="room-list">
              {visibleRooms.map((room) => {
                const full = room.playerCount >= room.maxPlayers;
                const joinable = !full && room.status === 'waiting' && connected;
                return (
                  <li key={room.id} className="room-row">
                    <div className="room-main">
                      <span className="room-name">{room.name}</span>
                      <span className="room-code">{room.id}</span>
                    </div>
                    <div className="room-meta">
                      <span className="room-host">房主 {room.hostName}</span>
                      <span className={`pill pill-${room.status}`}>
                        {ROOM_STATUS_LABEL[room.status]}
                      </span>
                      <span className="room-count">
                        {room.playerCount}/{room.maxPlayers}
                      </span>
                      {room.gameType === 'gomoku' ? (
                        <span className="room-size">{room.boardSize ?? DEFAULT_GOMOKU_SIZE} 路</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-small room-join"
                      disabled={!joinable}
                      onClick={() => onJoinRoom(room.id)}
                    >
                      {full ? '已满' : '加入'}
                    </button>
                    {full || room.status !== 'waiting' ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        disabled={!connected}
                        onClick={() => onWatchRoom(room.id)}
                      >
                        <IconWatch />
                        观战
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="room-guide" aria-label="玩法说明">
            <div className="room-guide-item">
              <span className="room-guide-index">01</span>
              <span>{meta.guide[0]}</span>
            </div>
            <div className="room-guide-item">
              <span className="room-guide-index">02</span>
              <span>{meta.guide[1]}</span>
            </div>
            <div className="room-guide-item">
              <span className="room-guide-index">03</span>
              <span>{meta.guide[2]}</span>
            </div>
          </div>
          <p className="rooms-note">私密房间不出现在列表中，可用房间码或邀请链接加入。</p>
        </div>

        <div className="lobby-side">
          <div className="card glass join-card">
            <header className="card-header">
              <div>
                <h2>输入房间码加入</h2>
                <p className="card-sub">6 位房间码，支持私密房间</p>
              </div>
            </header>
            <form className="join-form" onSubmit={handleJoin}>
              <input
                className="input code-input"
                type="text"
                value={joinCode}
                placeholder="例如 8F3KQ2"
                maxLength={6}
                inputMode="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-label="6 位房间码"
                onChange={(event) => {
                  setJoinCode(normalizeRoomCode(event.target.value));
                  setJoinError('');
                }}
              />
              <div className="join-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!canStart || !joinCodeReady}
                >
                  加入
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!canStart || !joinCodeReady}
                  onClick={() => {
                    const code = normalizeRoomCode(joinCode);
                    if (code.length !== 6) {
                      setJoinError('请输入 6 位房间码');
                      return;
                    }
                    setJoinError('');
                    onWatchRoom(code);
                  }}
                >
                  <IconWatch />
                  观战
                </button>
              </div>
            </form>
            {joinError ? <p className="field-hint error">{joinError}</p> : null}
            <p className="join-hint">
              {initialRoomCode
                ? '已从邀请链接填入房间码，确认昵称后点击加入。'
                : '邀请链接会自动填好房间码。'}
              满房或对局已开始时，可以点「观战」只读观看。
            </p>
          </div>

          <div className="card glass records-card">
            <header className="card-header records-head">
              <div>
                <h2>最近战绩</h2>
                <p className="card-sub">最近 10 局 · 随浏览器身份保存</p>
              </div>
              {records.length > 0 ? (
                <div className="record-summary">
                  <span className="record-chip win">胜 {wins}</span>
                  <span className="record-chip loss">负 {losses}</span>
                  <span className="record-chip draw">和 {draws}</span>
                </div>
              ) : null}
            </header>

            {records.length === 0 ? (
              <div className="record-empty">
                <span className="record-empty-icon" aria-hidden="true">
                  <span className="empty-stone black" />
                  <span className="empty-stone white" />
                </span>
                <p className="record-empty-title">还没有对局记录</p>
                <p className="record-empty-sub">来一局吧，胜负有据可查。</p>
                <div className="record-empty-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={handleQuickMatch}
                    disabled={!canStart}
                  >
                    <IconBolt />
                    立即匹配
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => setAiOpen(true)}
                    disabled={!canStart}
                  >
                    <IconBot />
                    与电脑对战
                  </button>
                </div>
              </div>
            ) : (
              <ul className="record-list">
                {records.map((record, index) => (
                  <li key={`${record.at}-${index}`} className="record-row">
                    <span className={`record-result result-${record.result}`}>
                      {RECORD_RESULT_LABEL[record.result]}
                    </span>
                    <span className="record-main">
                      <span className="record-opponent">
                        {record.mode === 'ai' ? '电脑' : record.opponent || '棋友'}
                      </span>
                      <span className="record-tags">
                        <span className={`record-mode mode-${record.mode}`}>
                          {record.mode === 'ai' ? '人机' : '联机'}
                        </span>
                        <span className="record-game">{GAME_LABEL[record.gameType]}</span>
                        <span>{COLOR_LABEL[record.myColor]}</span>
                        <span>{END_REASON_LABEL[record.endedReason ?? ''] ?? '对局'}</span>
                        <span>{record.moves} 手</span>
                      </span>
                    </span>
                    <span className="record-time">{formatRecordTime(record.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={createOpen}
        title="创建房间"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={!canStart}>
              创建并进入
            </button>
          </>
        }
      >
        <label className="field">
          <span className="field-label">房间名（可空）</span>
          <input
            className="input"
            type="text"
            value={roomName}
            maxLength={MAX_ROOM_NAME_LENGTH}
            placeholder="留空则自动命名"
            onChange={(event) => setRoomName(event.target.value)}
          />
          <span className="field-hint">最多 {MAX_ROOM_NAME_LENGTH} 个字符。</span>
        </label>

        <div className="field">
          <span className="field-label">可见性</span>
          <div className="segmented" role="group" aria-label="房间可见性">
            {(
              [
                { value: 'public', label: '公开', hint: '出现在大厅列表' },
                { value: 'private', label: '私密', hint: '仅房间码可加入' },
              ] as Array<{ value: RoomVisibility; label: string; hint: string }>
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segmented-item${visibility === option.value ? ' is-active' : ''}`}
                aria-pressed={visibility === option.value}
                onClick={() => setVisibility(option.value)}
              >
                <span className="segmented-label">{option.label}</span>
                <span className="segmented-hint">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">执子颜色</span>
          <div className="segmented segmented-three" role="group" aria-label="执子颜色">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segmented-item${color === option.value ? ' is-active' : ''}`}
                aria-pressed={color === option.value}
                onClick={() => setColor(option.value)}
              >
                <span className={`mini-stone stone-${option.value === 'random' ? 'random' : option.value}`} aria-hidden="true" />
                <span className="segmented-label">{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        {gameType === 'gomoku' ? (
          <BoardSizeField value={boardSize} onChange={setBoardSize} />
        ) : null}
      </Modal>

      <Modal
        open={aiOpen}
        title="人机对战"
        onClose={() => setAiOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setAiOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={handleAiStart} disabled={!canStart}>
              开始对局
            </button>
          </>
        }
      >
        <p className="action-hint">
          与电脑对弈，无需等待对手；电脑执相反颜色，{gameType === 'chess' ? '红棋先行。' : '黑棋先行。'}
        </p>
        <div className="field">
          <span className="field-label">执子颜色</span>
          <div className="segmented segmented-three" role="group" aria-label="人机对战执子颜色">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segmented-item${aiColor === option.value ? ' is-active' : ''}`}
                aria-pressed={aiColor === option.value}
                onClick={() => setAiColor(option.value)}
              >
                <span className={`mini-stone stone-${option.value === 'random' ? 'random' : option.value}`} aria-hidden="true" />
                <span className="segmented-label">{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        {gameType === 'gomoku' ? (
          <BoardSizeField value={boardSize} onChange={setBoardSize} />
        ) : null}
      </Modal>
    </section>
  );
}
