# 跨端共享契约

- `realtime-v3.fixtures.json`：协议 v3 二进制帧的黄金样例（hex + 期望解码结果）。
  前端 `web/src/lib/realtime/codec.test.ts` 与后端 `server/tests/test_realtime_codec.py`
  读取同一份文件，任何一侧改字段都必须让两边测试同时通过。
- 生成脚本：`scripts/gen_realtime_fixtures.py`（从后端 codec 生成，勿手改 hex）。
