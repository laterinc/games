import type { ToastItem } from '../types';

interface ToastProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

const TOAST_ICONS: Record<ToastItem['level'], string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '✕',
};

/** 轻提示堆叠：承载 notice 与 error 消息，自动消失（计时在 useGameSocket 中）。 */
export function Toast({ toasts, onDismiss }: ToastProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.level}`}>
          <span className="toast-icon" aria-hidden="true">
            {TOAST_ICONS[toast.level]}
          </span>
          <span className="toast-text">{toast.text}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => onDismiss(toast.id)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
