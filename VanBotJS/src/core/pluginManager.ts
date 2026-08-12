import { readdir } from "fs/promises"
import { watch } from "fs"
import { join, resolve } from "path"
import { globalBus } from "./eventBus.js"
import type { BotEvent } from "./models/event.js"
import type { BaseAdapter } from "../adapter/base.js"

export interface BotPlugin {
  name: string
  version?: string
  /** 收到事件时回调 */
  onEvent?: (event: BotEvent, bot: BaseAdapter) => Promise<void> | void
  /** 插件启用时回调 */
  onEnable?: () => Promise<void> | void
  /** 插件禁用时回调 */
  onDisable?: () => Promise<void> | void
}

type PluginHandler = (eventName: string, event: BotEvent, bot: BaseAdapter) => void

interface LoadedPlugin {
  name: string
  module: Record<string, any>
  handler: PluginHandler | null
  filePath: string
  enabled: boolean
}

// 插件管理器
export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private readonly pluginDir: string
  private readonly enabledMap: Record<string, boolean>
  private readonly hotReload: boolean
  private reloadTimers = new Map<string, NodeJS.Timeout>()
  private watcher: ReturnType<typeof watch> | null = null

  constructor(
    pluginDir: string,
    enabledMap: Record<string, boolean>,
    hotReload = true
  ) {
    this.pluginDir = resolve(pluginDir)
    this.enabledMap = enabledMap
    this.hotReload = hotReload
  }

  // 扫描并加载所有插件
  async loadAll(): Promise<void> {
    let files: string[]
    try {
      files = await readdir(this.pluginDir)
    } catch {
      console.warn(`[插件] 插件目录不存在: ${this.pluginDir}`)
      return
    }

    const tsFiles = files.filter(f => f.endsWith(".ts") && !f.startsWith("_"))
    console.log(`[插件] 发现 ${tsFiles.length} 个插件文件`)

    for (const file of tsFiles) {
      const name = file.replace(/\.ts$/, "")
      if (this.enabledMap[name] === false) {
        console.log(`[插件] ${name} 已在配置中禁用，跳过加载`)
        continue
      }
      try {
        await this.loadPlugin(name, join(this.pluginDir, file))
      } catch (err) {
        console.error(`[插件] 加载 ${name} 失败:`, err)
      }
    }

    if (this.hotReload) this.startWatch()
  }

  // 加载单个插件
  private async loadPlugin(name: string, filePath: string): Promise<void> {
    const mod = await this.dynamicImport(filePath)
    const handler = this.buildHandler(name, mod)

    const plugin: LoadedPlugin = {
      name,
      module: mod,
      handler,
      filePath,
      enabled: false,
    }
    this.plugins.set(name, plugin)

    const shouldEnable = this.enabledMap[name] ?? false
    if (shouldEnable) {
      await this.enablePlugin(name)
    } else {
      console.log(`[插件] ${name} 已加载（未启用）`)
    }
  }

  // 根据模块导出构建事件处理器
  private buildHandler(name: string, mod: Record<string, any>): PluginHandler | null {
    // 标准插件：default 导出 BotPlugin
    if (mod.default?.onEvent) {
      return (_eventName: string, event: BotEvent, bot: BaseAdapter) => {
        Promise.resolve(mod.default.onEvent(event, bot)).catch(e =>
          console.error(`[插件:${name}] onEvent 异常:`, e)
        )
      }
    }
    // 标准插件：命名导出 onEvent(eventName, event, bot)
    if (typeof mod.onEvent === "function") {
      return (_eventName: string, event: BotEvent, bot: BaseAdapter) => {
        Promise.resolve(mod.onEvent(event, bot)).catch(e =>
          console.error(`[插件:${name}] onEvent 异常:`, e)
        )
      }
    }
    // 兼容旧格式：handleAllEvent(eventName, event, bot)
    if (typeof mod.handleAllEvent === "function") {
      return (eventName: string, event: BotEvent, bot: BaseAdapter) => {
        Promise.resolve(mod.handleAllEvent(eventName, event, bot)).catch(e =>
          console.error(`[插件:${name}] handleAllEvent 异常:`, e)
        )
      }
    }
    console.warn(`[插件] ${name} 未导出 onEvent / handleAllEvent，将不接收事件`)
    return null
  }

  // 动态导入模块，加时间戳绕过缓存以支持热重载
  private async dynamicImport(filePath: string): Promise<Record<string, any>> {
    const normalized = filePath.replace(/\\/g, "/")
    const url = `file:///${normalized}?t=${Date.now()}`
    return await import(url)
  }

  // 启用插件
  async enablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) {
      console.warn(`[插件] 未找到 ${name}`)
      return
    }
    if (plugin.enabled) return

    if (plugin.handler) {
      globalBus.on("*", plugin.handler)
    }
    if (typeof plugin.module.onEnable === "function") {
      await plugin.module.onEnable()
    } else if (typeof plugin.module.default?.onEnable === "function") {
      await plugin.module.default.onEnable()
    }
    plugin.enabled = true
    console.log(`[插件] ${name} 已启用`)
  }

  // 禁用插件
  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin || !plugin.enabled) return

    if (plugin.handler) {
      globalBus.off("*", plugin.handler)
    }
    if (typeof plugin.module.onDisable === "function") {
      await plugin.module.onDisable()
    } else if (typeof plugin.module.default?.onDisable === "function") {
      await plugin.module.default.onDisable()
    }
    plugin.enabled = false
    console.log(`[插件] ${name} 已禁用`)
  }

  // 热重载单个插件
  async reloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) return

    const wasEnabled = plugin.enabled
    if (wasEnabled) await this.disablePlugin(name)

    try {
      const mod = await this.dynamicImport(plugin.filePath)
      plugin.module = mod
      plugin.handler = this.buildHandler(name, mod)
      if (wasEnabled) await this.enablePlugin(name)
      console.log(`[插件] ${name} 热重载完成`)
    } catch (err) {
      console.error(`[插件] ${name} 热重载失败，保持原版本:`, err)
      // 恢复原模块
      if (wasEnabled) await this.enablePlugin(name)
    }
  }

  // 获取已启用插件名列表
  getEnabledNames(): string[] {
    const result: string[] = []
    for (const p of this.plugins.values()) {
      if (p.enabled) result.push(p.name)
    }
    return result
  }

  // 启动文件监听实现热加载
  private startWatch(): void {
    try {
      this.watcher = watch(this.pluginDir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith(".ts")) return
        const name = filename.replace(/\.ts$/, "")

        // 防抖：1000ms 内多次改动只重载一次
        if (this.reloadTimers.has(name)) return
        const timer = setTimeout(() => {
          this.reloadTimers.delete(name)
          this.reloadPlugin(name).catch(e =>
            console.error(`[插件] ${name} 重载异常:`, e)
          )
        }, 1000)
        this.reloadTimers.set(name, timer)
      })
      console.log(`[插件] 热加载监听已启动: ${this.pluginDir}`)
    } catch (err) {
      console.warn(`[插件] 热加载监听启动失败:`, err)
    }
  }

  // 停止所有插件并清理
  async destroy(): Promise<void> {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    for (const name of [...this.plugins.keys()]) {
      await this.disablePlugin(name)
    }
    this.plugins.clear()
  }
}
