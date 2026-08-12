import WebSocket from "ws"
import fetch from "node-fetch"
import { randomUUID } from "crypto"
import { BaseAdapter } from "../base.js"
import { convertMilkyEvent } from "./converter.js"
import type { MilkyRawEvent } from "./types.js"
import { registerBot } from "../../core/botRegistry.js"

export const MilkyAdapterMap = new Map<string, MilkyAdapter>()

export class MilkyAdapter extends BaseAdapter {
    public readonly botId: string
    private readonly cfg: Record<string, any>
    private ws?: WebSocket
    private reconnectTimer?: NodeJS.Timeout

    constructor(config: Record<string, any>) {
        super()
        this.cfg = config
        this.botId = config.botId
        MilkyAdapterMap.set(this.botId, this)
        registerBot(this)
    }

    public async connect(): Promise<void> {
        const port = this.cfg.port ?? 3000
        const token = this.cfg.token ?? ""
        const cfgPath = this.cfg.path ?? "/event"
        const wsUrl = new URL("ws://127.0.0.1")
        wsUrl.port = String(port)
        wsUrl.pathname = cfgPath
        if (token) wsUrl.searchParams.set("token", token)
        const fullWsUrl = wsUrl.toString()

        console.log(`[Milky ${this.botId}] 事件WS连接地址：${fullWsUrl}`)
        const ws = new WebSocket(fullWsUrl)
        this.ws = ws

        setTimeout(() => this.bindWs(), 100)

        ws.on("open", () => {
            this.connected = true
            console.log(`✅ [Milky ${this.botId}] /event WS 事件通道连接成功`)
        })
        ws.on("close", (code, reason) => {
            console.log(`[Milky ${this.botId}] WS关闭 code:${code} ${reason}`)
            this.connected = false
            this.reconnect()
        })
        ws.on("error", () => {
            console.log(`[Milky ${this.botId}] WS连接失败，请确认Milky服务已启动`)
        })
    }

    public async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = undefined
        }
        if (this.ws) {
            this.ws.close(1000, "程序退出")
            this.ws = undefined
        }
        this.connected = false
    }

    private bindWs(): void {
        if (!this.ws) return
        this.ws.on("message", (buf) => {
            try {
                const text = buf.toString()
                const json = JSON.parse(text) as MilkyRawEvent
                convertMilkyEvent(json, this.botId)
            } catch (e) {
                console.error(`[Milky ${this.botId}] 事件报文解析失败`, e)
            }
        })
    }

    private reconnect(): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        console.log(`[Milky ${this.botId}] 30秒后自动重连事件WS`)
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch(e => console.error(`[Milky ${this.botId}] 重连失败:`, e))
        }, 30000)
    }

    public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
        const port = this.cfg.port ?? 3000
        const token = this.cfg.token ?? ""
        const baseUrl = new URL("http://127.0.0.1")
        baseUrl.port = String(port)

        let targetApi = action
        const reqParams = { ...params }

        if (action === "send_msg") {
            if (reqParams.group_id) {
                targetApi = "send_group"
                reqParams.gid = reqParams.group_id
                delete reqParams.group_id
            } else if (reqParams.user_id) {
                targetApi = "send_private"
                reqParams.uid = reqParams.user_id
                delete reqParams.user_id
            }
        }

        baseUrl.pathname = `/api/${targetApi}`
        const fullApiUrl = baseUrl.toString()

        const echo = randomUUID()
        const body = { echo, params: reqParams }
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (token) headers.Authorization = `Bearer ${token}`

        const res = await fetch(fullApiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        })

        const rawText = await res.text()

        if (res.status === 404) {
            throw new Error(`Milky接口404：不存在接口 /api/${targetApi}，确认Milky已开启EnabledHttp并重启`)
        }

        let ret: any
        try {
            ret = JSON.parse(rawText)
        } catch {
            throw new Error(`Milky API返回非JSON内容：${rawText}`)
        }

        if (ret.retcode !== 0) {
            throw new Error(`Milky接口调用失败 retcode:${ret.retcode} 提示:${ret.message ?? "无"}`)
        }
        return ret.data as T
    }

    public async destroy(): Promise<void> {
        await this.disconnect()
        MilkyAdapterMap.delete(this.botId)
    }
}

export function getMilkyAdapterById(botId: string): MilkyAdapter | undefined {
    return MilkyAdapterMap.get(botId)
}
