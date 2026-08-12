// 单个机器人实例配置
export interface BotConfig {
  // 框架内唯一标识
  botId: string
  // 适配器类型
  type: "onebot11" | "milky" | "satori" | "wechat"
  // 连接模式（onebot11 用）
  mode?: "ws_client" | "ws_reverse"
  // 监听端口（反向 WS / HTTP）
  port?: number
  // WS 路径
  path?: string
  // 正向 WS 地址
  url?: string
  // 鉴权 token 
  token?: string
  // Satori / 其他协议的平台标识
  platform?: string
  [key: string]: any
}

// 插件配置：key 为插件名（不含扩展名），value 为是否启用
export type PluginConfig = Record<string, boolean>

// 顶层配置文件结构
export interface AppConfig {
  bots: BotConfig[]
  plugins: PluginConfig
  /** 插件热加载开关，默认 true */
  hotReload?: boolean
}

// 兼容旧版纯数组格式
export type RawConfig = AppConfig | BotConfig[]
