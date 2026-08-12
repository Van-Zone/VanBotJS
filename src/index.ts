import { readFile } from "fs/promises"
import { resolve, join } from "path"
import { OneBot11Adapter } from "./adapter/onebot11/client.js"
import { MilkyAdapter } from "./adapter/milky/client.js"
import { SatoriAdapter } from "./adapter/satori/client.js"
import { WechatAdapter } from "./adapter/wechat/client.js"
import { PluginManager } from "./core/pluginManager.js"
import type { AppConfig, BotConfig, RawConfig } from "./core/config.js"
import type { BaseAdapter } from "./adapter/base.js"

const CONFIG_PATH = resolve("./config.json")
const PLUGIN_DIR = join(process.cwd(), "src", "cmd")

/*
// ASCII Logo
const LOGO = `
██╗   ██╗ █████╗ ███╗   ██╗██████╗  ██████╗ ████████╗     ██╗███████╗
██║   ██║██╔══██╗████╗  ██║██╔══██╗██╔═══██╗╚══██╔══╝     ██║██╔════╝
██║   ██║███████║██╔██╗ ██║██████╔╝██║   ██║   ██║        ██║███████╗
╚██╗ ██╔╝██╔══██║██║╚██╗██║██╔══██╗██║   ██║   ██║   ██   ██║╚════██║
 ╚████╔╝ ██║  ██║██║ ╚████║██████╔╝╚██████╔╝   ██║   ╚█████╔╝███████║
  ╚═══╝  ╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝  ╚═════╝    ╚═╝    ╚════╝ ╚══════╝
`
/*
 __  __                   ____            __        _____  ____       
/\ \/\ \                 /\  _`\         /\ \__    /\___ \/\  _`\     
\ \ \ \ \     __      ___\ \ \L\ \    ___\ \ ,_\   \/__/\ \ \,\L\_\   
 \ \ \ \ \  /'__`\  /' _ `\ \  _ <'  / __`\ \ \/      _\ \ \/_\__ \   
  \ \ \_/ \/\ \L\.\_/\ \/\ \ \ \L\ \/\ \L\ \ \ \_  __/\ \_\ \/\ \L\ \ 
   \ `\___/\ \__/.\_\ \_\ \_\ \____/\ \____/\ \__\/\_\ \____/\ `\____\
    `\/__/  \/__/\/_/\/_/\/_/\/___/  \/___/  \/__/\/_/\/___/  \/_____/                                                   
*/
// Larry 3D
const LOGO = `
 __  __                   ____            __        _____  ____       
/\\ \\/\\ \\                 /\\  _\`\\         /\\ \\__    /\\___ \\/\\  _\`\\     
\\ \\ \\ \\ \\     __      ___\\ \\ \\L\\ \\    ___\\ \\ ,_\\   \\/__/\\ \\ \\,\\L\\_\\   
 \\ \\ \\ \\ \\  /'__\`\\  /' _ \`\\ \\  _ <'  / __\`\\ \\ \\/      _\\ \\ \\/_\\__ \\   
  \\ \\ \\_/ \\/\\ \\L\\.\\_/\\ \\/\\ \\ \\ \\L\\ \\/\\ \\L\\ \\ \\ \\_  __/\\ \\_\\ \\/\\ \\L\\ \\ 
   \\ \`\\___/\\ \\__/.\\_\\ \\_\\ \\_\\ \\____/\\ \\____/\\ \\__\\/\\_\\ \\____/\\ \`\\____\\
    \`\\/__/  \\/__/\\/_/\\/_/\\/_/\\/___/  \\/___/  \\/__/\\/_/\\/___/  \\/_____/   
`

async function loadConfig(): Promise<AppConfig> {
  const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as RawConfig

  // 兼容旧版纯数组格式
  if (Array.isArray(raw)) {
    console.log("[配置] 检测到旧版数组格式，自动转换")
    return {
      bots: raw as BotConfig[],
      plugins: { keyword: true },
      hotReload: true,
    }
  }

  return raw as AppConfig
}

function createAdapter(cfg: BotConfig): BaseAdapter | null {
  switch (cfg.type) {
    case "onebot11":
      return new OneBot11Adapter(cfg)
    case "milky":
      return new MilkyAdapter(cfg)
    case "satori":
      return new SatoriAdapter(cfg)
    case "wechat":
      return new WechatAdapter(cfg)
    default:
      console.error(`[配置] 未知适配器类型: ${cfg.type} (botId: ${cfg.botId})`)
      return null
  }
}

async function bootstrap(): Promise<void> {
  console.log(LOGO)
  console.log("VanBotJS 启动中...\n")

  // 加载配置
  const config = await loadConfig()
  console.log(`[配置] 已加载 ${config.bots.length} 个机器人实例`)
  console.log(`[配置] 插件热加载: ${config.hotReload !== false ? "开启" : "关闭"}`)

  // 启动适配器
  const adapters: BaseAdapter[] = []
  for (const cfg of config.bots) {
    const adapter = createAdapter(cfg)
    if (!adapter) continue
    try {
      await adapter.connect()
      adapters.push(adapter)
      console.log(`[启动] ${cfg.type} 适配器已启动: ${cfg.botId}`)
    } catch (err) {
      console.error(`[启动] ${cfg.botId} 连接失败:`, err)
    }
  }

  if (adapters.length === 0) {
    console.warn("[启动] 没有成功连接的适配器，程序退出")
    process.exit(1)
  }

  // 加载插件
  const pluginManager = new PluginManager(
    PLUGIN_DIR,
    config.plugins ?? {},
    config.hotReload !== false
  )
  await pluginManager.loadAll()

  const enabled = pluginManager.getEnabledNames()
  console.log(`\n[启动] 已启用插件: ${enabled.length > 0 ? enabled.join(", ") : "无"}`)
  console.log("[启动] VanBotJS 启动完成，等待事件...\n")

  // 优雅关闭
  const shutdown = async (signal: string) => {
    console.log(`\n[关闭] 收到 ${signal} 信号，正在优雅关闭...`)
    await pluginManager.destroy()
    for (const adapter of adapters) {
      try {
        await adapter.destroy()
        console.log(`[关闭] ${adapter.botId} 已断开`)
      } catch (err) {
        console.error(`[关闭] ${adapter.botId} 断开异常:`, err)
      }
    }
    console.log("[关闭] 全部资源已释放，程序退出")
    process.exit(0)
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

bootstrap().catch(err => {
  console.error("[启动失败]", err)
  process.exit(1)
})
