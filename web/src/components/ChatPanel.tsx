import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '../types';
import { MAX_CHAT_LENGTH } from '../lib/protocol';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  myPlayerId: string | null;
  disabled?: boolean;
}

function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 房间聊天：回车发送、1–200 字、自动滚到底、按 id 去重由上层完成。 */
export function ChatPanel({ messages, onSend, myPlayerId, disabled = false }: ChatPanelProps) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages]);

  const trimmed = text.trim();
  const canSend = !disabled && trimmed.length >= 1 && trimmed.length <= MAX_CHAT_LENGTH;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSend) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <section className="chat-panel card glass" aria-label="房间聊天">
      <header className="chat-header">
        <h2>聊天</h2>
        <span className="chat-count">{messages.length} 条</span>
      </header>
      <div className="chat-list" ref={listRef} role="log" aria-live="polite">
        {messages.length === 0 ? (
          <p className="chat-empty">还没有人发言，打个招呼吧。</p>
        ) : (
          messages.map((message) => {
            const own = myPlayerId !== null && message.playerId === myPlayerId;
            return (
              <div key={message.id} className={`chat-message${own ? ' is-own' : ''}`}>
                <div className="chat-meta">
                  <span className="chat-name">{message.name || '棋友'}</span>
                  <span className="chat-time">{formatTime(message.at)}</span>
                </div>
                <p className="chat-text">{message.text}</p>
              </div>
            );
          })
        )}
      </div>
      <form className="chat-form" onSubmit={handleSubmit}>
        <input
          className="input chat-input"
          type="text"
          value={text}
          maxLength={MAX_CHAT_LENGTH}
          placeholder="说点什么…（回车发送）"
          aria-label="聊天内容"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => setText(event.target.value.slice(0, MAX_CHAT_LENGTH))}
        />
        {text.length > 160 ? (
          <span className="chat-counter" aria-live="polite">
            {text.length}/{MAX_CHAT_LENGTH}
          </span>
        ) : null}
        <button type="submit" className="btn btn-primary btn-small" disabled={!canSend}>
          发送
        </button>
      </form>
    </section>
  );
}
