import type { MessageChain } from "./message.js"

export type EventType =
  | "group_message"
  | "private_message"
  | "message_sent"
  | "notice"
  | "meta_event"
  | "request"
  | "*"

// 框架统一事件结构，所有适配器转换后都走这个
export interface BotEvent {
  // 框架内机器人标识 */
  botId: string
  // 协议侧自身 ID（QQ号 / platform id）
  selfId: number | string
  // 发送者 ID */
  userId: number | string
  // 群 ID，私聊时为 undefined / 0
  groupId?: number | string
  // 消息段数组（统一为 {type, data} 格式）
  message: Array<{ type: string; data: Record<string, any> }>
  // 事件类型
  postType: EventType
  // 原始协议报文（调试用）
  raw: Record<string, any>
}

// 兼容旧代码的别名
export type BaseBotEvent = BotEvent
