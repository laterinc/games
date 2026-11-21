import { useEffect, useState, type FormEvent } from 'react';
import type { CreateColor, RoomSummary, RoomVisibility, ToastLevel } from '../types';
import {
  CREATE_COLOR_LABEL,
  MAX_NICKNAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  ROOM_STATUS_LABEL,
} from '../lib/protocol';
import { Modal } from './Modal';

interface LobbyProps {
  nickname: string;
  onNicknameChange: (value: string) => void;
  rooms: RoomSummary[];
  connected: boolean;
  initialRoomCode: string;
  onQuickMatch: () => void;
  onCreateRoom: (options: {
    roomName: string;
    visibility: RoomVisibility;
    color: CreateColor;
  }) => void;
  onJoinRoom: (roomId: string) => void;
  onRefreshRooms: () => void;
  notify: (text: string, level?: ToastLevel) => void;
}

const COLOR_OPTIONS: Array<{ value: CreateColor; label: string }> = [
  { value: 'black', label: CREATE_COLOR_LABEL.black },
  { value: 'white', label: CREATE_COLOR_LABEL.white },
  { value: 'random', label: CREATE_COLOR_LABEL.random },
];

function normalizeRoomCode(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 6)
    .toUpperCase();
}

/** 大厅：昵称、快速匹配、创建房间、公开房间列表、房间码加入。 */
export function Lobby({
  nickname,
  onNicknameChange,
  rooms,
  connected,
  initialRoomCode,
  onQuickMatch,
  onCreateRoom,
  onJoinRoom,
  onRefreshRooms,
  notify,
}: LobbyProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [visibility, setVisibility] = useState<RoomVisibility>('public');
  const [color, setColor] = useState<CreateColor>('black');
  const [joinCode, setJoinCode] = useState(initialRoomCode);
  const [joinError, setJoinError] = useState('');

  useEffect(() => {
    if (initialRoomCode) setJoinCode(initialRoomCode);
  }, [initialRoomCode]);

  const trimmedNickname = nickname.trim();
  const nicknameValid =
    trimmedNickname.length >= 1 && trimmedNickname.length <= MAX_NICKNAME_LENGTH;
  const canStart = connected && nicknameValid;
  const roomNameValid = roomName.trim().length <= MAX_ROOM_NAME_LENGTH;

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
    onCreateRoom({ roomName: roomName.trim(), visibility, color });
    setCreateOpen(false);
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
    <section className="lobby">
      <div className="lobby-hero card glass">
        <div className="hero-intro">
          <div className="hero-brand">
            <span className="hero-stones" aria-hidden="true">
              <span className="mini-stone stone-black" />
              <span className="mini-stone stone-white" />
            </span>
            <div>
              <h1>五子棋 · 联机对战</h1>
              <p className="hero-sub">黑棋先行，先连成五子者胜。快速匹配，或邀请好友来一局。</p>
            </div>
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
              快速匹配
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-large"
              onClick={() => setCreateOpen(true)}
              disabled={!canStart}
            >
              创建房间
            </button>
          </div>
          {!connected ? <p className="hint-warn">正在连接服务器，连接成功后才能开始对局。</p> : null}
        </div>
        <div className="hero-visual" aria-hidden="true">
          <span className="hero-board-grid" />
          <span className="hero-stone hero-stone-black" />
          <span className="hero-stone hero-stone-white" />
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
              刷新
            </button>
          </header>
          {rooms.length === 0 ? (
            <p className="rooms-empty">
              {connected ? '暂无公开房间，创建一个，或直接快速匹配。' : '正在连接服务器…'}
            </p>
          ) : (
            <ul className="room-list">
              {rooms.map((room) => {
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
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-small room-join"
                      disabled={!joinable}
                      onClick={() => onJoinRoom(room.id)}
                    >
                      {full ? '已满' : '加入'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="rooms-note">私密房间不出现在列表中，可用房间码或邀请链接加入。</p>
        </div>

        <div className="card glass join-card">
          <h2>输入房间码加入</h2>
          <p className="card-sub">6 位房间码，支持私密房间。</p>
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
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canStart || normalizeRoomCode(joinCode).length !== 6}
            >
              加入
            </button>
          </form>
          {joinError ? <p className="field-hint error">{joinError}</p> : null}
          <p className="join-hint">
            {initialRoomCode
              ? '已从邀请链接填入房间码，确认昵称后点击加入。'
              : '邀请链接会自动填好房间码。'}
          </p>
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
            {COLOR_OPTIONS.map((option) => (
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
      </Modal>
    </section>
  );
}
