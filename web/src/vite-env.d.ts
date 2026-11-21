/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 可选：覆盖 WebSocket 地址（默认同源 /ws）。 */
  readonly VITE_WS_URL?: string;
  /** 可选：REST 基地址（默认空 = 同源）。 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
