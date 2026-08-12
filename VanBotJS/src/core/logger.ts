// src/core/logger.ts
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function getTime() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${m}-${day} ${h}:${s}`;
}

/**
 * @param selfId 机器人QQ（绿色）
 * @param dir <- / ->
 * @param type 私聊/群聊/事件
 * @param targetId 群号/对方QQ/触发者QQ
 * @param content 消息/事件完整转码文本
 */
export function botLog(
    selfId: string,
    dir: "<-" | "->",
    type: "私聊" | "群聊" | "通知" | "事件" | "插件",
    targetId: string,
    content: string
) {
    const time = getTime();
    const botStr = `${GREEN}${selfId}${RESET}`;
    let line = "";
    if (type === "私聊" || type === "群聊") {
        line = `${time} | ${botStr} ${dir} ${type} (${targetId}) ${content}`;
    } else {
        line = `${time} | ${botStr} ${dir} ${type} (${targetId}) ${content}`;
    }
    console.log(line);
}