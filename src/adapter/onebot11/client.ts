import WebSocket, { WebSocketServer } from "ws"
import { randomUUID } from "crypto"
import { BaseAdapter } from "../base.js"
import type { OB11ApiReq, OB11ConnectMode } from "./types.js"
import { convertOb11Event } from "./converter.js"
import type { MessageChain } from "../../core/models/message.js"
import { registerBot } from "../../core/botRegistry.js"

export class OneBot11Adapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private ws?: WebSocket
  private wss?: WebSocketServer
  private reconnectTimer?: NodeJS.Timeout

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    registerBot(this)
  }

  public async connect(): Promise<void> {
    const mode = this.cfg.mode as OB11ConnectMode
    if (mode === "ws_reverse") {
      this.startWsServer()
    } else if (mode === "ws_client") {
      await this.startWsClient()
    } else {
      throw new Error(`[${this.botId}] 未知连接模式: ${mode}`)
    }
  }

  public async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.ws) {
      this.ws.close()
      this.ws = undefined
    }
    if (this.wss) {
      this.wss.close()
      this.wss = undefined
    }
    this.connected = false
  }

  private startWsServer(): void {
    if (this.wss) {
      this.wss.close(() => {
        console.log(`[${this.botId}] 旧WS服务已关闭，释放端口`)
      })
    }

    const wss = new WebSocketServer({ port: this.cfg.port })
    this.wss = wss

    wss.on("connection", (ws, req) => {
      if (req.url !== this.cfg.path) {
        return ws.close(1008, "path not match")
      }
      const authHeader = req.headers.authorization
      if (this.cfg.token && authHeader !== `Bearer ${this.cfg.token}`) {
        return ws.close(1008, "token invalid")
      }

      this.ws = ws
      this.connected = true
      this.bindWsEvents()
      console.log(`✅ [${this.botId}] OneBot11 反向WS客户端连接成功`)
    })

    wss.on("error", (err) => {
      console.error(`[${this.botId}] WS服务监听异常：`, err)
    })

    console.log(`[${this.botId}] OneBot11 反向WS监听 | 端口:${this.cfg.port} 路径:${this.cfg.path}`)
  }

  private async startWsClient(): Promise<void> {
    const ws = new WebSocket(this.cfg.url)
    this.ws = ws

    ws.on("open", () => {
      this.connected = true
      console.log(`✅ [${this.botId}] OneBot11 正向WS连接成功`)
    })

    this.bindWsEvents()
  }

  private bindWsEvents(): void {
    if (!this.ws) return

    this.ws.on("message", (rawData) => {
      try {
        const json = JSON.parse(rawData.toString())
        convertOb11Event(json, this.botId, this)
      } catch (err) {
        console.error(`[${this.botId}] 解析OB11消息失败：`, err)
      }
    })

    this.ws.on("close", (code) => {
      console.log(`[${this.botId}] 连接关闭 code:${code}，2秒后重连`)
      this.connected = false
      this.ws = undefined

      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      if (this.wss) this.wss.close()

      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(e => console.error(`[${this.botId}] 重连失败:`, e))
      }, 2000)
    })

    this.ws.on("error", (err) => {
      console.error(`[${this.botId}] WS连接异常：`, err)
    })
  }

  // 通用 API 调用
  public async callApi<T = any>(action: string, params?: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WS未连接，无法调用API"))
      }
      const reqId = randomUUID()
      const req: OB11ApiReq = {
        action,
        params: params ?? {},
        echo: reqId,
      }
      this.ws.send(JSON.stringify(req))

      const tempHandler = (raw: Buffer) => {
        try {
          const res = JSON.parse(raw.toString())
          if (res.echo === reqId) {
            this.ws?.off("message", tempHandler)
            if (res.retcode === 0) resolve(res.data)
            else reject(new Error(`API返回错误：${res.msg}`))
          }
        } catch {
          // 忽略解析错误
        }
      }
      this.ws.on("message", tempHandler)

      setTimeout(() => {
        this.ws?.off("message", tempHandler)
        reject(new Error(`API ${action} 请求超时`))
      }, 10000)
    })
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
  }
}
