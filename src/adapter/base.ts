import type { BotEvent } from "../core/models/event.js"
import type { MessageChain } from "../core/models/message.js"
import { globalBus } from "../core/eventBus.js"
import { registerBot, registerSelfId, unregisterBot } from "../core/botRegistry.js"

/**
 * 适配器基类
 * 所有协议适配器（OneBot11 / Milky / Satori）都继承此类
 */
export abstract class BaseAdapter {
  /** 框架内机器人标识 */
  public botId: string = ""
  /** 是否已连接 */
  public connected: boolean = false

  constructor() {
    // 子类自行设置 this.botId 后会自动注册
  }

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract callApi<T = any>(action: string, params?: Record<string, any>): Promise<T>

  // 发送群消息
  async sendGroupMsg(groupId: number | string, chain: MessageChain | string): Promise<any> {
    const message = typeof chain === "string" ? chain : chain.map(s => s.toOneBot11())
    return this.callApi("send_group_msg", { group_id: groupId, message })
  }

  // 发送私聊消息
  async sendPrivateMsg(userId: number | string, chain: MessageChain | string): Promise<any> {
    const message = typeof chain === "string" ? chain : chain.map(s => s.toOneBot11())
    return this.callApi("send_private_msg", { user_id: userId, message })
  }

  // 自动判断群/私聊发送
  async sendMsg(
    target: { groupId?: number | string; userId?: number | string },
    chain: MessageChain | string
  ): Promise<any> {
    if (target.groupId) {
      return this.sendGroupMsg(target.groupId, chain)
    }
    return this.sendPrivateMsg(target.userId ?? 0, chain)
  }

  /**
   * 将转换后的统一事件派发到事件总线
   * 插件通过 globalBus 监听事件
   * 同时自动登记 selfId 到全局注册表，支持 get_bot(Q号) 查找
   */
  emitEvent(eventName: string, event: BotEvent): void {
    if (event.selfId) registerSelfId(this, event.selfId)
    globalBus.emit(eventName, event, this)
  }

  // 销毁适配器，释放资源
  async destroy(): Promise<void> {
    await this.disconnect()
    unregisterBot(this)
  }
}
