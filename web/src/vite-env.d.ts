/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 可选：覆盖 WebSocket 地址（默认同源 /ws）。
   * 支持 wss://host/ws、/ws、host/ws 三种写法，见 web/.env.example。
   */
  readonly VITE_WS_URL?: string;
  /**
   * 可选：REST 基地址（默认空 = 同源）。
   * 填绝对地址且未设置 VITE_WS_URL 时，WebSocket 自动推导为 ws(s)://<该 host>/ws。
   */
  readonly VITE_API_BASE?: string;
  /** 前端部署子路径，例如 /gomoku/；默认 /。 */
  readonly VITE_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
