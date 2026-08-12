import WebSocket from "ws"
import fetch from "node-fetch"
import { BaseAdapter } from "../base.js"
import { convertSatoriEvent, segmentsToSatoriContent } from "./converter.js"
import type { SatoriEvent, SatoriOpCode, SatoriWsFrame } from "./types.js"
import { registerBot } from "../../core/botRegistry.js"

export const SatoriAdapterMap = new Map<string, SatoriAdapter>()

export class SatoriAdapter extends BaseAdapter {
    public readonly botId: string
    private readonly cfg: Record<string, any>
    private ws?: WebSocket
    private reconnectTimer?: NodeJS.Timeout
    private heartbeatTimer?: NodeJS.Timeout
    private apiBaseUrl: string = ""

    constructor(config: Record<string, any>) {
        super()
        this.cfg = config
        this.botId = config.botId
        SatoriAdapterMap.set(this.botId, this)
        registerBot(this)
    }

    public async connect(): Promise<void> {
        const host = this.cfg.host ?? "127.0.0.1"
        const port = this.cfg.port ?? 5140
        const token = this.cfg.token ?? ""
        const path = this.cfg.path ?? "/v1/events"

        const wsUrl = new URL(`ws://${host}:${port}${path}`)
        this.apiBaseUrl = `http://${host}:${port}/v1`

        console.log(`[Satori ${this.botId}] 连接地址：${wsUrl.toString()}`)
        const ws = new WebSocket(wsUrl.toString())
        this.ws = ws

        ws.on("open", () => {
            console.log(`✅ [Satori ${this.botId}] WebSocket 已连接，发送鉴权`)
            // 发送 IDENTIFY
            const identifyFrame: SatoriWsFrame = {
                op: 3 as SatoriOpCode,
                body: { token },
            }
            ws.send(JSON.stringify(identifyFrame))
        })

        this.bindWsEvents()
    }

    public async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = undefined
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = undefined
        }
        if (this.ws) {
            this.ws.close()
            this.ws = undefined
        }
        this.connected = false
    }

    private bindWsEvents(): void {
        if (!this.ws) return

        this.ws.on("message", (buf) => {
            try {
                const frame: SatoriWsFrame = JSON.parse(buf.toString())
                this.handleWsFrame(frame)
            } catch (e) {
                console.error(`[Satori ${this.botId}] WS报文解析失败`, e)
            }
        })

        this.ws.on("close", (code) => {
            console.log(`[Satori ${this.botId}] WS关闭 code:${code}，5秒后重连`)
            this.connected = false
            this.stopHeartbeat()
            this.reconnect()
        })

        this.ws.on("error", (err) => {
            console.error(`[Satori ${this.botId}] WS连接异常:`, err.message)
        })
    }

    private handleWsFrame(frame: SatoriWsFrame): void {
        switch (frame.op) {
            case 0: // EVENT
                if (frame.body) {
                    const event = frame.body as SatoriEvent
                    convertSatoriEvent(event, this.botId)
                }
                break
            case 1: // PING (服务端发心跳)
                // 回复 PONG
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ op: 2 }))
                }
                break
            case 2: // PONG
                // 收到心跳响应
                break
            case 4: // READY
                this.connected = true
                console.log(`✅ [Satori ${this.botId}] 鉴权成功，就绪`)
                if (frame.body?.logins) {
                    const logins = frame.body.logins as Array<{ self_id: string; platform: string }>
                    logins.forEach(l => {
                        console.log(`  登录账号: platform=${l.platform} self_id=${l.self_id}`)
                    })
                }
                this.startHeartbeat()
                break
            default:
                console.log(`[Satori ${this.botId}] 未知 op: ${frame.op}`)
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat()
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 1 })) // PING
            }
        }, 15000) // 15秒心跳
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = undefined
        }
    }

    private reconnect(): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch(e => console.error(`[Satori ${this.botId}] 重连失败:`, e))
        }, 5000)
    }

    // API 调用
    /**
     * 调用 Satori API
     * 标准方式: HTTP POST /v1/{action}
     */
    public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
        const token = this.cfg.token ?? ""

        // 兼容 OneBot 风格的 action 名称，映射到 Satori
        const satoriAction = this.mapAction(action)
        const satoriParams = this.mapParams(action, params)

        const url = `${this.apiBaseUrl}/${satoriAction}`
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        }
        if (token) headers.Authorization = `Bearer ${token}`

        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(satoriParams),
            signal: AbortSignal.timeout(10000),
        })

        const rawText = await res.text()
        if (!res.ok) {
            throw new Error(`Satori API ${satoriAction} 失败: HTTP ${res.status} ${rawText}`)
        }

        let ret: any
        try {
            ret = JSON.parse(rawText)
        } catch {
            return rawText as unknown as T
        }

        // Satori 标准返回直接是 data，部分实现包裹一层
        if (ret && ret.data !== undefined) return ret.data as T
        return ret as T
    }

    // OneBot action → Satori action 映射
    private mapAction(action: string): string {
        const map: Record<string, string> = {
            "send_msg": "message.create",
            "send_group_msg": "message.create",
            "send_private_msg": "message.create",
            "delete_msg": "message.delete",
            "get_msg": "message.get",
            "get_group_member_list": "guild.member.list",
            "get_group_member_info": "guild.member.get",
            "get_group_list": "guild.list",
            "set_group_kick": "guild.member.kick",
            "set_group_ban": "guild.member.mute",
            "set_group_whole_ban": "guild.member.mute",
        }
        return map[action] ?? action
    }

    // OneBot params → Satori params 映射
    private mapParams(action: string, params: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = { ...params }

        // 发送消息：转换消息格式 + 映射 ID
        if (action === "send_msg" || action === "send_group_msg" || action === "send_private_msg") {
            // channel_id 优先，其次 group_id / user_id
            if (params.channel_id) {
                result.channel_id = params.channel_id
            } else if (params.group_id) {
                result.channel_id = String(params.group_id)
            } else if (params.user_id) {
                // 私信需要 user_id，Satori 用 channel_id 或 direct message
                result.user_id = String(params.user_id)
            }
            delete result.group_id
            delete result.user_id

            // 消息内容转换
            if (Array.isArray(params.message)) {
                result.content = segmentsToSatoriContent(params.message)
                delete result.message
            } else if (typeof params.message === "string") {
                result.content = params.message
                delete result.message
            }
        }

        // 撤回消息
        if (action === "delete_msg") {
            if (params.message_id) {
                result.message_id = String(params.message_id)
            }
        }

        return result
    }

    async sendGroupMsg(groupId: number | string, chain: any): Promise<any> {
        const content = Array.isArray(chain)
            ? segmentsToSatoriContent(chain)
            : String(chain)
        return this.callApi("message.create", {
            channel_id: String(groupId),
            content,
        })
    }

    async sendPrivateMsg(userId: number | string, chain: any): Promise<any> {
        const content = Array.isArray(chain)
            ? segmentsToSatoriContent(chain)
            : String(chain)
        return this.callApi("message.create", {
            user_id: String(userId),
            content,
        })
    }

    public async destroy(): Promise<void> {
        await this.disconnect()
        SatoriAdapterMap.delete(this.botId)
    }
}

export function getSatoriAdapterById(botId: string): SatoriAdapter | undefined {
    return SatoriAdapterMap.get(botId)
}
