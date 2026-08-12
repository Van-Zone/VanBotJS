import http from "http"
import { createHash } from "crypto"
import fetch from "node-fetch"
import { BaseAdapter } from "../base.js"
import { convertWechatEvent, parseWechatXml, buildPassiveReply } from "./converter.js"
import type { WechatRawPayload, WechatApiResp, WechatAccessTokenResp } from "./types.js"
import { registerBot } from "../../core/botRegistry.js"

export const WechatAdapterMap = new Map<string, WechatAdapter>()

/**
 * 微信公众号 / 服务号 适配器
 *
 * 工作原理：
 * 1. 启动 HTTP 服务器监听微信回调（服务器配置URL）
 * 2. GET 请求：验证服务器地址（signature + echostr）
 * 3. POST 请求：接收用户消息/事件，转换为框架统一事件派发
 * 4. 发送消息：通过客服消息 API（需 access_token），用户48小时内交互过才能发送
 * 5. 被动回复：在5秒内直接返回 XML 响应（可选，通过 callApi("passive_reply")）
 *
 * 配置项：
 *   botId       - 框架内标识
 *   type        - "wechat"
 *   appId       - 公众号 AppID
 *   appSecret   - 公众号 AppSecret
 *   token       - 服务器配置 Token
 *   port        - 回调监听端口
 *   path        - 回调路径，默认 /wechat/callback
 *   encodingAESKey - 消息加解密密钥（暂仅支持明文模式，留空即可）
 */
export class WechatAdapter extends BaseAdapter {
    public readonly botId: string
    private readonly cfg: Record<string, any>
    private server?: http.Server
    private accessToken: string = ""
    private accessTokenExpireAt: number = 0
    // 存储待被动回复的内容（按 FromUserName 索引）
    private passiveReplyMap = new Map<string, string>()

    constructor(config: Record<string, any>) {
        super()
        this.cfg = config
        this.botId = config.botId
        WechatAdapterMap.set(this.botId, this)
        registerBot(this)
    }

    public async connect(): Promise<void> {
        const port = this.cfg.port ?? 80
        const path = this.cfg.path ?? "/wechat/callback"
        const token = this.cfg.token ?? ""

        this.server = http.createServer((req, res) => {
            const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`)

            // 路径校验
            if (reqUrl.pathname !== path) {
                res.writeHead(404)
                res.end("Not Found")
                return
            }

            if (req.method === "GET") {
                // 服务器地址验证
                this.handleVerify(reqUrl, token, res)
            } else if (req.method === "POST") {
                // 接收消息
                this.handleMessage(req, res)
            } else {
                res.writeHead(405)
                res.end("Method Not Allowed")
            }
        })

        this.server.listen(port, () => {
            console.log(`✅ [WeChat ${this.botId}] 回调服务已启动 | 端口:${port} 路径:${path}`)
            console.log(`   请在微信公众平台配置服务器地址：http://<你的域名>:${port}${path}`)
        })

        this.server.on("error", (err) => {
            console.error(`[WeChat ${this.botId}] 回调服务异常：`, err)
        })

        this.connected = true

        // 预取 access_token
        this.refreshAccessToken().catch(e => console.warn(`[WeChat ${this.botId}] 初始 access_token 获取失败：`, e.message))
    }

    public async disconnect(): Promise<void> {
        if (this.server) {
            this.server.close()
            this.server = undefined
        }
        this.connected = false
        console.log(`[WeChat ${this.botId}] 回调服务已关闭`)
    }

    /**
     * 服务器地址验证（GET）
     * 微信发送 signature, timestamp, nonce, echostr
     * 校验通过后原样返回 echostr
     */
    private handleVerify(reqUrl: URL, token: string, res: http.ServerResponse): void {
        const signature = reqUrl.searchParams.get("signature") ?? ""
        const timestamp = reqUrl.searchParams.get("timestamp") ?? ""
        const nonce = reqUrl.searchParams.get("nonce") ?? ""
        const echostr = reqUrl.searchParams.get("echostr") ?? ""

        const arr = [token, timestamp, nonce].sort()
        const calculated = createHash("sha1").update(arr.join("")).digest("hex")

        if (calculated === signature) {
            res.writeHead(200, { "Content-Type": "text/plain" })
            res.end(echostr)
            console.log(`[WeChat ${this.botId}] 服务器地址验证通过`)
        } else {
            res.writeHead(403)
            res.end("Invalid signature")
            console.warn(`[WeChat ${this.botId}] 服务器地址验证失败：签名不匹配`)
        }
    }

    /**
     * 接收消息（POST）
     */
    private handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", () => {
            try {
                const parsed = parseWechatXml(body) as unknown as WechatRawPayload
                const fromUser = parsed.FromUserName

                // 转换并派发事件
                convertWechatEvent(parsed, this.botId, this)

                // 检查是否有待发送的被动回复
                const passiveReply = this.passiveReplyMap.get(fromUser)
                if (passiveReply) {
                    this.passiveReplyMap.delete(fromUser)
                    const replyXml = buildPassiveReply(fromUser, parsed.ToUserName, passiveReply)
                    res.writeHead(200, { "Content-Type": "application/xml" })
                    res.end(replyXml)
                } else {
                    // 无被动回复，返回空字符串表示不回复（微信不会重试）
                    res.writeHead(200, { "Content-Type": "text/plain" })
                    res.end("")
                }
            } catch (err) {
                console.error(`[WeChat ${this.botId}] 消息处理失败：`, err)
                res.writeHead(200, { "Content-Type": "text/plain" })
                res.end("")
            }
        })
    }

    /**
     * 获取并缓存 access_token
     * 有效期 7200 秒，提前 300 秒刷新
     */
    private async refreshAccessToken(): Promise<string> {
        const now = Date.now()
        if (this.accessToken && now < this.accessTokenExpireAt - 300000) {
            return this.accessToken
        }

        const appId = this.cfg.appId
        const appSecret = this.cfg.appSecret
        if (!appId || !appSecret) {
            throw new Error(`[WeChat ${this.botId}] 缺少 appId 或 appSecret，无法获取 access_token`)
        }

        const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
        const data = (await res.json()) as WechatAccessTokenResp & { errcode?: number; errmsg?: string }

        if (data.errcode) {
            throw new Error(`[WeChat ${this.botId}] 获取 access_token 失败：${data.errmsg} (errcode:${data.errcode})`)
        }

        this.accessToken = data.access_token
        this.accessTokenExpireAt = now + data.expires_in * 1000
        console.log(`[WeChat ${this.botId}] access_token 已刷新，有效期 ${data.expires_in} 秒`)
        return this.accessToken
    }

    /**
     * 调用微信 API
     * 支持的 action：
     *   - send_private_msg / send_msg    : 发送客服消息（params: { user_id, message }）
     *   - send_group_msg                 : 公众号无群，等同 send_private_msg
     *   - passive_reply                  : 设置被动回复（params: { user_id, content }）
     *   - template_send                  : 发送模板消息（params: 模板消息完整结构）
     *   - user_info                      : 获取用户信息（params: { user_id }）
     *   - 其他                           : 直接透传到微信 API（params 作为请求体）
     */
    public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
        // 被动回复：不调用 API，直接存入 map 等待回调响应
        if (action === "passive_reply") {
            const userId = params.user_id ?? params.touser
            const content = params.content ?? params.text ?? ""
            if (userId) this.passiveReplyMap.set(String(userId), String(content))
            return { errcode: 0, errmsg: "ok" } as T
        }

        const token = await this.refreshAccessToken()

        // 发送客服消息
        if (action === "send_private_msg" || action === "send_msg" || action === "send_group_msg") {
            return this.sendKfMessage(token, params) as Promise<T>
        }

        // 模板消息
        if (action === "template_send") {
            return this.postWechatApi(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`, params) as Promise<T>
        }

        // 获取用户信息
        if (action === "user_info") {
            const userId = params.user_id ?? params.openid
            const url = `https://api.weixin.qq.com/cgi-bin/user/info?access_token=${token}&openid=${userId}&lang=zh_CN`
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
            return res.json() as Promise<T>
        }

        // 其他 action 透传：action 作为 API 路径
        const url = `https://api.weixin.qq.com/cgi-bin/${action}?access_token=${token}`
        return this.postWechatApi(url, params) as Promise<T>
    }

    /**
     * 发送客服消息
     * message 支持字符串（文本）或消息段数组
     */
    private async sendKfMessage(token: string, params: Record<string, any>): Promise<WechatApiResp> {
        const userId = params.user_id ?? params.touser
        if (!userId) throw new Error("缺少 user_id / touser 参数")

        const message = params.message
        let body: Record<string, any>

        if (typeof message === "string") {
            // 纯文本
            body = {
                touser: String(userId),
                msgtype: "text",
                text: { content: message },
            }
        } else if (Array.isArray(message)) {
            // 消息段数组，取第一个文本段
            const textSeg = message.find((s: any) => s.type === "text")
            const imageSeg = message.find((s: any) => s.type === "image")
            if (imageSeg) {
                body = {
                    touser: String(userId),
                    msgtype: "image",
                    image: { media_id: imageSeg.data?.media_id ?? imageSeg.data?.file ?? "" },
                }
            } else {
                const content = textSeg?.data?.text ?? message.map((s: any) => s.data?.text ?? "").join("")
                body = {
                    touser: String(userId),
                    msgtype: "text",
                    text: { content },
                }
            }
        } else {
            // 直接作为消息体
            body = { touser: String(userId), ...message }
        }

        return this.postWechatApi(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`, body)
    }

    /**
     * POST 微信 API 通用方法
     */
    private async postWechatApi(url: string, body: Record<string, any>): Promise<WechatApiResp> {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        })
        const data = (await res.json()) as WechatApiResp
        if (data.errcode && data.errcode !== 0) {
            throw new Error(`微信API错误：${data.errmsg} (errcode:${data.errcode})`)
        }
        return data
    }

    /**
     * 重写发送私聊消息（公众号全部是私聊）
     */
    public async sendPrivateMsg(userId: number | string, chain: any): Promise<any> {
        return this.callApi("send_private_msg", { user_id: userId, message: chain })
    }

    /**
     * 公众号无群聊，sendGroupMsg 等同 sendPrivateMsg
     */
    public async sendGroupMsg(groupId: number | string, chain: any): Promise<any> {
        return this.callApi("send_private_msg", { user_id: groupId, message: chain })
    }

    public async destroy(): Promise<void> {
        await this.disconnect()
        WechatAdapterMap.delete(this.botId)
        super.destroy()
    }
}

export function getWechatAdapterById(botId: string): WechatAdapter | undefined {
    return WechatAdapterMap.get(botId)
}
