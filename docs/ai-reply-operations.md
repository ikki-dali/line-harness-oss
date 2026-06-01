# AI 応答（キャリアカウンセラー）運用メモ

採用プロの公式 LINE で、keyword automation 未ヒットのテキストメッセージに
Claude（persona: キャリアカウンセラー）が自動応答する MVP の運用設定。

## 仕組み（実装済み）

1. LINE メッセージ → `webhook.ts` → `fireEvent('message_received')`
2. `processAutomations` が keyword ルールを評価。**応答したら true** を返す。
3. 未応答 かつ テキストあり のとき `maybeAiReply` が発火:
   - `friends.metadata.handover === 'human'` なら**黙る**（有人対応中）
   - `messages_log` の直近 10 往復を履歴として Claude に渡す
   - 応答を `splitForLine`（500字目安・文境界）で分割し push
   - Claude が落ちたら fallback 文（無言にしない）

## 必要シークレット

- `ANTHROPIC_API_KEY`（`wrangler secret put ANTHROPIC_API_KEY`）。
  未設定なら AI フォールバックは発火せず無言（`maybeAiReply` がガード）。

## 人 × AI 切替（handover）

- 状態は `friends.metadata.handover`（`'ai'` 既定 / `'human'`）。新規テーブルなし。
- **takeover（自動）**: オペレーターが `POST /api/chats/:id/send` で手動返信すると
  自動で `handover='human'` になり AI が黙る。
- **AI 復帰**: `POST /api/chats/:id/resume-ai` で `handover='ai'` に戻す。

## エスカレ automation（特定 keyword → 人へ）※ランタイム設定（Task 3.5.4）

新規コード不要。既存 automation 機構（`event-bus.ts` の `set_metadata` アクション）で実現する。
管理画面 or seed で以下の automation を登録する:

- `event_type`: `message_received`
- `conditions`: `{ "keyword": "人と話したい" }`（「給与」「クレーム」等も同様に登録）
- `actions`:
  - `set_metadata` — `params.data`: `{"handover":"human"}`（以降 AI は黙る）
  - 担当者通知（既存の通知アクション）

→ 該当 keyword 受信で `handover='human'` がセットされ、`maybeAiReply` のガードで AI が停止する。
実機で「該当ワード送信 → AI 沈黙 + 担当者通知」を確認すること。

## 明示的に「やらない」決定（Task 4.3 / YAGNI）

- **応答の自然な遅延（即レス回避演出）**: 本 MVP では実装しない。
  Cloudflare Workers は長時間 sleep に不向き（課金・実行時間）。
  必要になったら Queue / Durable Object Alarm で遅延 push する設計を別計画に切り出す。
  まず実機の体感で要否を判断する。
