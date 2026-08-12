import { botLog } from "../core/logger.js";
import type { BaseAdapter } from "../adapter/base.js";
import type { BotEvent } from "../core/models/event.js";
import { get_bot } from "../core/botRegistry.js";
import { transMessage, transNotice, transMeta } from "./transEvent.js";
import fs from "fs/promises";
import path from "path";
import * as schedule from "node-schedule";

// 文件位置
const ROOT_DIR = process.cwd();
const PLUGIN_DATA = path.join(ROOT_DIR, "Van_keyword");
const CONFIG_FILE_PATH = path.join(PLUGIN_DATA, "config.json");
// 发送变量 (发送消息ID)
const global_message_ids: Record<string, Record<string, number | undefined>> = {};
// 词条变量 (触发词条ID)
const global_lexicon_ids: Record<string, Record<string, number | undefined>> = {};
// 词汇量变量 (总词条数)
const global_lexicon_totals: Record<string, Record<string, number | undefined>> = {};
// 报错变量 (文本)
const global_error_reply: Record<string, Record<string, string | undefined>> = {};
// 其他
const fileCachePool = new Map<string, FileCacheItem>();
const jobPool: Record<string, PoolJob> = {};
const taskCache: Record<string, unknown> = {};
// 类型定义
type FileCacheItem = {
    rawText: string | null;
    jsonData: unknown | null;
    loadPromise: Promise<{ rawText: string; jsonData?: unknown }> | null;
};
type CoinDataItem = {
    group: string;
    type: string;
    user: string;
    data: number | string;
    uptime: string;
};
type CoinStorage = {
    work: CoinDataItem[];
};
type MsgSegment = { type: string; data: Record<string, unknown> };
type LexRule = { r: string[]; s: number };
type LexSingleItem = { id: number; } & Omit<Record<string, LexRule>, "id">;
type LexRootData = {
    work: LexSingleItem[];
    recycle: LexSingleItem[];
    maxId: number;
};
type CheckResult = [boolean, boolean];
// 词库匹配命中结果
type LexMatchResult = { replyList: string[]; capture: string[] | false };
// 任务相关
export interface TaskConfig {
  botId: string;
  groupId: string;
  userId: string;
  msg: string;
  time: string;
  cache: boolean;
}
export interface TaskListObj {
  work: TaskConfig[];
}
interface IntervalJob {
  timer: NodeJS.Timeout;
}
type PoolJob = schedule.Job | IntervalJob;
type ParseTimeResult = Date | schedule.RecurrenceRule | { intervalSec: number };


// 文件修改
export async function fileCacheIO(
    absolutePath: string,
    mode: "r" | "w",
    content?: string | unknown,
    forceRefresh = false
): Promise<string | any> {
    const ext = path.extname(absolutePath).toLowerCase();
    const isJsonFile = ext === ".json";

    if (mode === "w") {
        if (content === undefined) throw new Error("写入模式必须传入content参数");
        const dirPath = path.dirname(absolutePath);
        await fs.mkdir(dirPath, { recursive: true });

        let writeStr: string;
        if (isJsonFile && typeof content !== "string") {
            writeStr = JSON.stringify(content, null, 4);
        } else {
            writeStr = String(content);
        }

        await fs.writeFile(absolutePath, writeStr, "utf-8");
        fileCachePool.delete(absolutePath);
        return "写入成功";
    }

    if (forceRefresh) fileCachePool.delete(absolutePath);
    if (fileCachePool.has(absolutePath)) {
        const cache = fileCachePool.get(absolutePath)!;
        if (cache.rawText !== null && cache.loadPromise === null) {
            return isJsonFile ? cache.jsonData : cache.rawText;
        }
        if (cache.loadPromise) {
            const res = await cache.loadPromise;
            return isJsonFile ? res.jsonData : res.rawText;
        }
    }

    const cacheItem: FileCacheItem = {
        rawText: null,
        jsonData: null,
        loadPromise: null
    };
    fileCachePool.set(absolutePath, cacheItem);

    cacheItem.loadPromise = (async () => {
        try {
            const stat = await fs.stat(absolutePath);
            if (!stat.isFile()) throw new Error(`非文件: ${absolutePath}`);
            const rawText = await fs.readFile(absolutePath, "utf-8");
            cacheItem.rawText = rawText;

            let jsonData: unknown | undefined;
            if (isJsonFile) {
                jsonData = JSON.parse(rawText);
                cacheItem.jsonData = jsonData;
            }
            return { rawText, jsonData };
        } catch (err) {
            fileCachePool.delete(absolutePath);
            throw err;
        } finally {
            cacheItem.loadPromise = null;
        }
    })();

    const result = await cacheItem.loadPromise;
    return isJsonFile ? result.jsonData : result.rawText;
}

// 缓存清理工具
export const FileCacheManager = {
    clearSingle: (p: string) => fileCachePool.delete(p),
    clearAll: () => fileCachePool.clear(),
    getSize: () => fileCachePool.size
};

// 词库数据处理
async function LexiconManager(
    selfId: string,
    lexiconId: string,
    opType: string,
    kwargs: Record<string, any>
): Promise<string | LexMatchResult> {
    const getLexFilePath = (id: string) => path.join(PLUGIN_DATA, String(id), "lexicon", `${lexiconId}.json`);

    function _matchTemplate(templateKey: string, inputText: string): false | string[] {
        let safeKey = templateKey.replaceAll("[", "\\[").replaceAll("]", "\\]");
        const placeholderReg = /\\\[n\.(\d+)\\\]/g;
        const placeholders: number[] = [];
        let m: RegExpExecArray | null;
        while ((m = placeholderReg.exec(safeKey))) {
            placeholders.push(Number(m[1]));
        }
        const patternStr = "^" + safeKey.replaceAll(/\\\[n\.\d+\\\]/g, "(.+?)") + "$";
        try {
            const pattern = new RegExp(patternStr);
            const match = pattern.exec(inputText);
            if (!match) return false;
            const result: string[] = ["", "", "", "", "", "", ""];
            placeholders.forEach((idx, i) => {
                if (idx < result.length) {
                    result[idx] = match![i + 1];
                }
            });
            return result.every(x => !x) ? false : result;
        } catch {
            return false;
        }
    }

    const builtInItem: any = {
        id: 0,
        "say [n.1]": {
            r: ["[judge.{[userid]in[coin.0.OWNER.0.0.[selfid]]}|{[userid]in[coin.0.MASTER.0.0.[selfid]]}][n.1]"],
            s: 1
        }
    };

    const loadLex = async (force: boolean): Promise<LexRootData> => {
        if (force) fileCachePool.delete(getLexFilePath(selfId));
        let data: LexRootData;
        try {
            data = await fileCacheIO(getLexFilePath(selfId), "r") as LexRootData;
            data.work ??= [];
            data.recycle ??= [];
            data.maxId ??= 0;
        } catch {
            data = { work: [], recycle: [], maxId: 0 };
        }
        if (!data.work.find(item => item.id === 0)) {
            data.work.unshift(builtInItem);
        }
        global_lexicon_totals[selfId] ??= {};
        global_lexicon_totals[selfId].count = data.work.length;
        return data;
    };

    const saveLex = async (data: LexRootData) => {
        await fileCacheIO(getLexFilePath(selfId), "w", data);
        fileCachePool.delete(getLexFilePath(selfId));
        global_lexicon_totals[selfId] ??= {};
        global_lexicon_totals[selfId].count = data.work.length;
    };

    const validOps = new Set([
        "get", "add", "remove_name", "remove_id",
        "look_name", "look_id", "reset_id", "restore_all", "clear_trash"
    ]);
    if (!validOps.has(opType)) {
        return `无效操作！支持指令：${[...validOps].join("、")}`;
    }

    if (opType === "get") {
        const value = kwargs.value;
        if (!value) return "";
        const lexData = await loadLex(false);
        global_lexicon_ids[selfId] ??= {};

        const normalList: any[] = [];
        const pureWildcardList: any[] = [];
        for (const item of lexData.work) {
            const keys = Object.keys(item).filter(k => k !== "id");
            const keyword = keys[0];
            if(keyword === "[n.1]"){
                pureWildcardList.push({item, keyword});
            }else{
                normalList.push({item, keyword});
            }
        }

        for(const entry of normalList){
            const {item, keyword} = entry;
            const rule = item[keyword];
            const s = rule.s ?? 1;
            if (s === 1) {
                if(keyword.includes("[n.")){
                    const captureArr = _matchTemplate(keyword, value);
                    if(captureArr !== false){
                        global_lexicon_ids[selfId].hit = item.id;
                        return { replyList: rule.r, capture: captureArr };
                    }
                }else{
                    if(value === keyword){
                        global_lexicon_ids[selfId].hit = item.id;
                        return { replyList: rule.r, capture: false };
                    }
                }
            }else{
                if(value.includes(keyword)){
                    global_lexicon_ids[selfId].hit = item.id;
                    return { replyList: rule.r, capture: false };
                }
            }
        }

        const matchedWildcards: Array<{item:any, keyword:string, count:number}> = [];
        for(const entry of pureWildcardList){
            const {item, keyword} = entry;
            const rule = item[keyword];
            const s = rule.s ?? 1;
            if (s === 1) {
                const captureArr = _matchTemplate(keyword, value);
                if(captureArr !== false){
                    const count = (keyword.match(/\[n\.\d+\]/g) || []).length;
                    matchedWildcards.push({item, keyword, count});
                }
            }else{
                if(value.includes(keyword)){
                    const count = (keyword.match(/\[n\.\d+\]/g) || []).length;
                    matchedWildcards.push({item, keyword, count});
                }
            }
        }
        if(matchedWildcards.length > 0){
            matchedWildcards.sort((a,b)=>b.count - a.count);
            const best = matchedWildcards[0];
            global_lexicon_ids[selfId].hit = best.item.id;
            return { replyList: best.item[best.keyword].r, capture: _matchTemplate(best.keyword, value) || [] };
        }

        global_lexicon_ids[selfId].hit = 0;
        return "";
    }

    if (opType === "add") {
        const { n, r, s } = kwargs;
        if (!n || !r || s === undefined) {
            return "缺少参数：n(触发词)、r(回复内容)、s(模式1精准/0模糊)";
        }
        const lexData = await loadLex(true);
        const existIdx = lexData.work.findIndex(it => !!it[n]);
        if (existIdx >= 0) {
            const target = lexData.work[existIdx][n];
            if (!target.r.includes(r)) {
                target.r.push(r);
            }
        } else {
            lexData.work.push({ id: ++lexData.maxId, [n]: { r: [r], s } } as any);
        }
        await saveLex(lexData);
        return "添加成功";
    }

    if (opType === "remove_name") {
        const { remove_name } = kwargs;
        if (!remove_name) return "缺少参数 remove_name";
        const lexData = await loadLex(true);
        const keep: typeof lexData.work = [];
        const deleted: typeof lexData.work = [];
        for (const item of lexData.work) {
            const key = Object.keys(item).filter(k => k !== "id")[0];
            if (key === remove_name) {
                if (item.id !== 0) {
                    deleted.push(item);
                } else {
                    keep.push(item);
                }
            } else {
                keep.push(item);
            }
        }
        lexData.work = keep;
        lexData.recycle.push(...deleted);
        await saveLex(lexData);
        return deleted.length > 0 ? `成功删除${deleted.length}条词条，并移入回收站` : "未找到对应触发词词条";
    }

    if (opType === "remove_id") {
        const targetId = Number(kwargs.remove_id);
        if (isNaN(targetId) || targetId <= 0) return "id必须是正整数";
        const lexData = await loadLex(true);
        const idx = lexData.work.findIndex(it => it.id === targetId);
        if (idx === -1) return `不存在id:${targetId}`;
        const delItem = lexData.work.splice(idx, 1)[0];
        lexData.recycle.push(delItem);
        await saveLex(lexData);
        const key = Object.keys(delItem).filter(k => k !== "id")[0];
        return `已删除id${targetId}，触发词：${key}（移入回收站）`;
    }

    if (opType === "look_id") {
        let str: string = kwargs.look_id;
        if (!str) return "缺少参数 look_id";
        if (!str.includes("-")) str = `${str}-${str}`;
        const [startStr, endStr] = str.split("-");
        const start = Number(startStr), end = Number(endStr);
        if (isNaN(start) || isNaN(end)) return "区间格式错误，示例 1-10";
        const lexData = await loadLex(true);
        const msg: string[] = [];
        for (const item of lexData.work) {
            const key = Object.keys(item).filter(k => k !== "id")[0];
            const rule = item[key];
            if (item.id >= start && item.id <= end) {
                const mode = rule.s === 1 ? "[精准]" : "[模糊]";
                if (start === end) {
                    msg.push(`\n【ID:${item.id}】${key} ${mode}`);
                    rule.r.forEach((rr: string, i: number) => msg.push(`\n(${i + 1})${rr}`));
                } else {
                    msg.push(`\n${item.id}.${key}`);
                }
            }
        }
        msg.push(`\n当前词库总共${lexData.work.length}条词条，回收站${lexData.recycle.length}条`);
        return msg.join("");
    }

    if (opType === "look_name") {
        const lookName = kwargs.look_name;
        if (!lookName) return "缺少参数 look_name";
        const lexData = await loadLex(true);
        const res: string[] = [];
        let found = false;
        for (const item of lexData.work) {
            const key = Object.keys(item).filter(k => k !== "id")[0];
            if (key.includes(lookName)) {
                found = true;
                res.push(`ID${item.id}.${key}`);
            }
        }
        return found ? res.join("\n") : "未找到匹配词条";
    }

    if (opType === "reset_id") {
        const lexData = await loadLex(true);
        const builtIn = lexData.work.find(x => x.id === 0);
        const rest = lexData.work.filter(x => x.id !== 0);
        lexData.maxId = 0;
        for (const item of rest) {
            item.id = ++lexData.maxId;
        }
        lexData.work = builtIn ? [builtIn, ...rest] : rest;
        await saveLex(lexData);
        return `ID重整完成！共${lexData.work.length}条词条，ID重新从1开始连续排序`;
    }

    if (opType === "restore_all") {
        const lexData = await loadLex(true);
        const count = lexData.recycle.length;
        if (count === 0) return "回收站为空，无词条可以恢复";
        lexData.work.push(...lexData.recycle);
        lexData.recycle = [];
        await saveLex(lexData);
        return `成功恢复${count}条词条（保留原始ID）`;
    }

    if (opType === "clear_trash") {
        const lexData = await loadLex(true);
        const count = lexData.recycle.length;
        lexData.recycle = [];
        await saveLex(lexData);
        return count > 0 ? `回收站已清空，永久删除${count}条词条` : "回收站本来就是空的";
    }

    return "未知操作类型";
}

// 文件base64处理
async function getUrlBase64(
    rawStr: string
): Promise<string> {
    // file
    if (rawStr.startsWith("file://")) {
        if (typeof window !== "undefined") {
            console.error("浏览器环境不支持 file:// 协议文件读取");
            return "";
        }

        let filePath = decodeURIComponent(rawStr.replace(/^file:\/\//, ""));
        // Windows file:///C:/xxx 去除开头多余斜杠
        if (/^\/[A-Za-z]:\//.test(filePath)) {
            filePath = filePath.slice(1);
        }

        try {
            const buf = await fs.readFile(filePath);
            return buf.toString("base64");
        } catch (err) {
            console.error("读取file://本地文件失败:", err);
            return "";
        }
    }
    // http / https
    let url = rawStr;
    const i1 = url.indexOf("http");
    const i2 = url.indexOf("http", i1 + 1);
    if (i2 !== -1) {
        url = url.slice(0, i2) + encodeURIComponent(url.slice(i2));
    }
    console.log("请求地址:", url);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);

    try {
        const headers: Record<string, string> = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
        };
        const opt: RequestInit = {
            method: "GET",
            signal: ctl.signal,
            headers
        };

        const res = await fetch(url, opt);
        if (!res.ok) {
            console.error(`资源请求失败，HTTP状态码：${res.status}`);
            return "";
        }
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        return buf.toString("base64");
    } catch (err) {
        console.error("获取资源二进制异常:", err);
        return "";
    } finally {
        clearTimeout(t);
    }
}

// OnebotAPI调用
async function onebotApi(
    bot: any,
    action: string,
    params: Record<string, unknown>
): Promise<any> {
    if (!bot?.ws || bot._adapter_type !== "napcat") {
        return bot.callApi(action, params);
    }

    return new Promise((resolve, reject) => {
        const echo = Date.now() + Math.random();
        const reqData = {
            action,
            params,
            echo
        };
        bot.ws.send(JSON.stringify(reqData));

        const tempHandler = (rawStr: string) => {
            try {
                const res = JSON.parse(rawStr);
                if (res.echo === echo) {
                    bot.ws.removeListener("message", tempHandler);
                    if (res.status === "ok") {
                        resolve(res.data);
                    } else {
                        reject(new Error(`API[${action}]失败: ${res.msg || res.wording || "未知错误"}`));
                    }
                }
            } catch { }
        };

        bot.ws.on("message", tempHandler);
        setTimeout(() => {
            bot.ws.removeListener("message", tempHandler);
            reject(new Error(`API[${action}]请求超时`));
        }, 10000);
    });
}

// 请求变量
async function req(
    rawStr: string,
    method: "GET" | "POST" = "GET",
    postData?: Record<string, unknown>
): Promise<string> {
    let url = rawStr;
    const i1 = url.indexOf("http"), i2 = url.indexOf("http", i1 + 1);
    if (i2 !== -1) url = url.slice(0, i2) + encodeURIComponent(url.slice(i2));
    console.log(url);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    try {
        const headers: Record<string, string> = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
        };
        const opt: RequestInit = {
            method,
            signal: ctl.signal,
            headers
        };
        if (method === "POST" && postData) {
            headers["Content-Type"] = "application/json";
            opt.body = JSON.stringify(postData);
        }
        const res = await fetch(url, opt);
        return (await res.text()).trim();
    } catch {
        return "";
    } finally {
        clearTimeout(t);
    }
}

// 积分变量
async function coins_operation(
    selfId: string,
    group: string,
    user: string,
    change: string,
    type: string
): Promise<string> {
    const lexPath = path.join(PLUGIN_DATA, String(selfId), "coins.json");
    let coins_data: CoinStorage;
    try {
        const data = await fileCacheIO(lexPath, "r", undefined, true) as Partial<CoinStorage>;
        if (!Array.isArray(data.work)) data.work = [];
        coins_data = data as CoinStorage;
    } catch {
        coins_data = { work: [] };
    }

    if (change === "0") {
        const target = coins_data.work.find(i => i.group === group && i.type === type && i.user === user);
        return String(target?.data ?? "0");
    }

    let assignMode = false, appendMode = false, removeMode = false;
    let returnChange = change;
    let coinsChange = 0, targetVal = "";
    const now = new Date().toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).replace(/\//g, "-");

    if (change.startsWith("||") && change.endsWith("||")) {
        returnChange = change.slice(2, -2);
        assignMode = true;
    } else if (change.startsWith("++")) {
        targetVal = change.slice(2).trim();
        appendMode = true;
    } else if (change.startsWith("--")) {
        targetVal = change.slice(2).trim();
        removeMode = true;
    } else if (/^[+-]\d+$/.test(change)) {
        const num = parseInt(change.slice(1));
        coinsChange = change.startsWith("+") ? num : -num;
    } else {
        throw new Error(`错误参数：${change}`);
    }

    const isNumber = (s: unknown) => !isNaN(parseFloat(String(s)));
    let updated = false;

    for (const item of coins_data.work) {
        if (item.group !== group || item.type !== type || item.user !== user) continue;
        if (assignMode) item.data = returnChange;
        else if (appendMode) {
            const list = String(item.data).trim() ? String(item.data).split(",") : [];
            if (!list.includes(targetVal)) list.push(targetVal);
            item.data = list.join(",");
            returnChange = item.data;
        } else if (removeMode) {
            const list = String(item.data).trim() ? String(item.data).split(",") : [];
            const idx = list.indexOf(targetVal);
            if (idx > -1) list.splice(idx, 1);
            item.data = list.join(",");
            returnChange = item.data;
        } else {
            const init = isNumber(item.data) ? parseInt(String(item.data)) : 0;
            item.data = init + coinsChange;
        }
        item.uptime = now;
        updated = true;
        break;
    }

    if (!updated) {
        let itemData: string | number;
        if (assignMode) itemData = returnChange;
        else if (appendMode) { itemData = targetVal; returnChange = itemData; }
        else if (removeMode) { itemData = ""; returnChange = itemData; }
        else itemData = coinsChange;
        coins_data.work.push({ group, type, user, data: itemData, uptime: now });
    }

    await fileCacheIO(lexPath, "w", coins_data);
    return returnChange;
}

// 判断变量
async function judge(
    text: string
): Promise<boolean> {
    const BOOL_TRUE = '{_BOOL_TRUE_}';
    const BOOL_FALSE = '{_BOOL_FALSE_}';
    const strip_quotes = (x: string): string => {
        x = x.trim();
        if (x.length >= 2) {
            const f = x[0];
            const l = x.at(-1)!;
            if ((f === "'" || f === '"') && f === l) return x.slice(1, -1).trim();
        }
        return x;
    };

    const check_single = (singleCond: string): CheckResult => {
        let s = singleCond.slice(1, -1).trim().replace(/\s+/g, ' ');
        if (!s) return [false, false];
        if (s === '_BOOL_TRUE_') return [true, true];
        if (s === '_BOOL_FALSE_') return [true, false];
        s = s.replace(/notin/gi, 'not in');

        const notInReg = /^(.+?)\s*not\s*in\s*(.+)$/i;
        const nm = s.match(notInReg);
        if (nm) {
            const v = strip_quotes(nm[1]);
            try {
                const arr = nm[2].split(',').map(item => strip_quotes(item)).filter(Boolean);
                return [true, arr.length ? !arr.includes(v) : true];
            } catch {
                return [false, false];
            }
        }

        const inReg = /^(.+?)\s*in\s*(.+)$/i;
        const im = s.match(inReg);
        if (im) {
            const v = strip_quotes(im[1]);
            try {
                const arr = im[2].split(',').map(item => strip_quotes(item)).filter(Boolean);
                return [true, arr.length ? arr.includes(v) : false];
            } catch {
                return [false, false];
            }
        }

        const opM = s.match(/(!=|>=|<=|==|>|<|=)/);
        if (opM) {
            const op = opM[1];
            const idx = opM.index!;
            const a = strip_quotes(s.slice(0, idx));
            const b = strip_quotes(s.slice(idx + op.length));
            const realOp = op === '=' ? '==' : op;
            if (realOp === '==') return [true, a === b];
            if (realOp === '!=') return [true, a !== b];
            try {
                const fa = parseFloat(a);
                const fb = parseFloat(b);
                if (realOp === '>') return [true, fa > fb];
                if (realOp === '<') return [true, fa < fb];
                if (realOp === '>=') return [true, fa >= fb];
                if (realOp === '<=') return [true, fa <= fb];
            } catch {
                return [false, false];
            }
        }
        return [false, false];
    };

    const calc_expr = (expr: string): boolean => {
        while (expr.includes('(')) {
            const bk = expr.match(/\(([^()]+)\)/) as any;
            if (!bk) break;
            const r = calc_expr(bk[1]);
            expr = expr.slice(0, bk.index) + (r ? BOOL_TRUE : BOOL_FALSE) + expr.slice(bk.index + bk[0].length);
        }
        const tokens = expr.match(/\{[^{}]+\}|[&|]/g) || [];
        if (!tokens.length) return false;
        const vals: boolean[] = [];
        const ops: string[] = [];
        for (const t of tokens) {
            if (t === '&' || t === '|') ops.push(t);
            else {
                const [ok, val] = check_single(t);
                if (!ok) return false;
                vals.push(val);
            }
        }
        if (ops.length !== vals.length - 1) return false;
        let i = 0;
        while (i < ops.length) {
            if (ops[i] === '&') {
                vals[i] = vals[i] && vals[i + 1];
                vals.splice(i + 1, 1);
                ops.splice(i, 1);
            } else i++;
        }
        return vals.some(Boolean);
    };

    let res = false;
    try { res = calc_expr(text); } catch {}
    return res;
}

// 分段变量
async function clauseTask(
    text: string, 
    bot: BaseAdapter, 
    event: BotEvent
): Promise<void> {
    const sleep = (s: number) => new Promise(resolve => setTimeout(resolve, s * 1000));
    const send = async (msg: string) => {
        const params = event.groupId && event.groupId !== 0 
            ? { group_id: event.groupId, message: msg } 
            : { user_id: event.userId, message: msg };
        await onebotApi(bot, "send_msg", params);
    };
    const numReg = /\[分段\.(\d+)\]/g;
    const nums = [...text.matchAll(numReg)].map(m => Number(m[1]));
    const parts = text.split(/\[分段\.\d+\]/);
    const texts = parts.map(s => s.trim()).filter(Boolean);
    const times = parts.at(-1) === '' ? nums.slice(0, -1) : nums;
    const max = Math.min(texts.length, times.length);
    for (let i = 0; i < max; i++) {
        const message = await parseBracketStr(texts[i], bot, event) as any;
        await send(message);
        await sleep(times[i]);
    }
    if (texts.length) {
        const lastMsg = await parseBracketStr(texts.at(-1)!, bot, event) as any;
        await send(lastMsg);
    }
}

// 结构变量
async function getValue(
    text: string
): Promise<string> {
    const reg = /(\[|【)[^.]+?\.(.+?)(\]|】)/;
    const match = text.match(reg);
    return match ? match[2] : text;
}

// 任务变量


// 待发消息处理
async function parseBracketStr(
    inputStr: string,
    bot: BaseAdapter,
    event: BotEvent
): Promise<MsgSegment[]> {
    const selfId = String(event.selfId);
    const userId = String(event.userId);
    const groupId = String(event.groupId);
    inputStr = lexiconValue(inputStr);
    const cfg = await fileCacheIO(CONFIG_FILE_PATH, "r") as Record<string, any>;
    const RANDOM_SEP = cfg.value?.or ?? "[or]";
    function escapeRegStr(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function lexiconValue(text: string): string {
        const reg = /\[lexicon([\s\S]*?)\|([01])\]/g;
        return text.replace(reg, (fullMatch, innerText, flag) => {
            const safeInner = innerText
                .replace(/\[/g, "［［")
                .replace(/\]/g, "］］");
            return `[lexicon${safeInner}|${flag}]`;
        });
    }
    async function matchTemplateGetParams(tpl: string, content: string): Promise<string[] | null> {
        const varReg = /\{p(\d+)\}/g;
        const placeholders: number[] = [];
        let safeTpl = escapeRegStr(tpl);
        let matchItem: RegExpExecArray | null;
        while ((matchItem = varReg.exec(tpl)) !== null) {
            const num = Number(matchItem[1]);
            placeholders.push(num);
            safeTpl = safeTpl.replace(`\\{p${num}\\}`, "(.*?)");
        }
        const reg = new RegExp(`^${safeTpl}$`);
        const result = content.match(reg);
        if (!result) return null;
        const params: string[] = [];
        for (let i = 0; i < placeholders.length; i++) {
            params[placeholders[i]] = result[i + 1];
        }
        return params;
    }
    function getTypeTemplate(typeKey: string): Record<string, string> {
        const item = cfg.value?.[typeKey];
        if (!item || typeof item.name !== "string") throw new Error(`value.${typeKey} 模板缺失`);
        return item;
    }
    // 根据配置自动生成 key.{p1}.{p2}...
    function buildKeyTemplate(typeKey: string, tplObj: Record<string, string>): string {
        const pNums: number[] = [];
        Object.keys(tplObj).forEach(k => {
            const m = k.match(/^p(\d+)$/);
            if (m) pNums.push(Number(m[1]));
        });
        pNums.sort((a, b) => a - b);
        const parts = [typeKey, ...pNums.map(n => `{p${n}}`)];
        return parts.join(".");
    }
    async function resolveValue(raw: string): Promise<string> {
        if (/\[([^\[\]]+)\]/.test(raw)) {
            const segList = await parseBracketStr(raw, bot, event);
            return segList.filter(s => s.type === "text").map(s => s.data.text).join("");
        }
        return raw;
    }
    async function operation(text: string, alltext: string): Promise<MsgSegment | string | null> {
        const typeMap: Array<{
            key: string;
            build: (p: string[]) => Promise<MsgSegment | string> | MsgSegment | string;
        }> = [
            { key: "at", build: (p) => ({ type: "at", data: { qq: p[1] } })},
            { key: "reply", build: (p) => ({ type: "reply", data: { id: p[1] } }) },
            { key: "face", build: (p) => ({ type: "face", data: { id: p[1] } }) },
            { key: "image", build: (p) => ({ type: "image", data: { file: p.slice(1).join(".") } }) },
            { key: "record", build: async(p) => ({ type: "record", data: { file: `base64://${await getUrlBase64(p.slice(1).join("."))}` } }) },
            { key: "video", build: async(p) => ({ type: "video", data: { file: `base64://${await getUrlBase64(p.slice(1).join("."))}` } }) },
            { key: "forward", build: (p) => ({ type: "forward", data: { id: p[1] } }) },
            { key: "dice", build: (p) => ({ type: "dice", data: { id: p[1] } }) },
            { key: "rps", build: (p) => ({ type: "rps", data: { id: p[1] } }) },
            { key: "poke", build: (p) => ({ type: "poke", data: { id: p[1] } }) },
            { key: "fileid", build: (p) => ({ type: "file", data: { file_id: p[1] } }) },
            { key: "file", build: (p) => ({ type: "file", data: { file: p.slice(1).join(".") } }) },
            { key: "json", build: (p) => ({ type: "json", data: { data: p.slice(1).join(".") } }) },
            {
                key: "music",
                build: async (p) => {
                    await onebotApi(bot, "send_group_msg", {
                        group_id: groupId,
                        message: [{
                            type: "music",
                            data: {
                                type: "custom",
                                url: p[3],
                                audio: p[2],
                                title: p[1],
                                image: p[4]
                            }
                        }]
                    });
                    return "";
                }
            },
            {
                key: "markdown",
                build: async (p) => {
                    await bot.callApi("send_group_msg", {
                    group_id: groupId,
                    message: [{
                            type: "card",
                            data: {
                                title: "分享链接",
                                url: p.slice(1).join(".")
                            }
                        }]
                    })
                    return "";
                }
            },
            {
                key: "pat",
                build: async (p) => {
                    if (p[2] == p[1]) {
                        await onebotApi(bot, "friend_poke", {
                            target_id: p[2],
                            user_id: p[1]
                        });
                    } else {
                        await onebotApi(bot, "group_poke", {
                            group_id: p[2],
                            user_id: p[1]
                        });
                    }
                    return "";
                }
            },
            {
                key: "sign",
                build: async (p) => {
                    await onebotApi(bot, "send_group_sign", {
                        group_id: p[1]
                    });
                    return "";
                }
            },
            {
                key: "emoji",
                build: async (p) => {
                    await onebotApi(bot, "set_msg_emoji_like", {
                        message_id: p[1],
                        emoji_id: p[2],
                        set: p[2] !== "0"
                    });
                    return "";
                }
            },
            {
                key: "like",
                build: async (p) => {
                    await onebotApi(bot, "send_like", {
                        user_id: p[2],
                        times: p[1]
                    });
                    return "";
                }
            },
            {
                key: "recall",
                build: async (p) => {
                    await onebotApi(bot, "delete_msg", {
                        message_id: p[1]
                    });
                    return "";
                }
            },
            {
                key: "ban",
                build: async (p) => {
                    if (p[2] == "all") {
                        await onebotApi(bot, "set_group_whole_ban", {
                            group_id: p[3],
                            enable: p[1]
                        });
                    } else {
                        await onebotApi(bot, "set_group_ban", {
                            group_id: p[3],
                            user_id: p[2],
                            duration: p[1]
                        });
                    }
                    return "";
                }
            },
            {
                key: "kick",
                build: async (p) => {
                    await onebotApi(bot, "set_group_kick", {
                        group_id: p[3],
                        user_id: p[1],
                        reject_add_request: p[2]
                    });
                    return "";
                }
            },
            {
                key: "setadmin",
                build: async (p) => {
                    await onebotApi(bot, "set_group_admin", {
                        group_id: p[3],
                        user_id: p[1],
                        enable: p[2]
                    });
                    return "";
                }
            },
            {
                key: "setcard",
                build: async (p) => {
                    await onebotApi(bot, "set_group_card", {
                        group_id: p[3],
                        user_id: p[2],
                        card: p[1]
                    });
                    return "";
                }
            },
            {
                key: "settitle",
                build: async (p) => {
                    await onebotApi(bot, "set_group_special_title", {
                        group_id: p[3],
                        user_id: p[2],
                        special_title: p[1]
                    });
                    return "";
                }
            },
            {
                key: "essence",
                build: async (p) => {
                    if (p[2]) {
                        await onebotApi(bot, "set_essence_msg", { message_id: p[1] });
                    } else {
                        await onebotApi(bot, "delete_essence_msg", { message_id: p[1] });
                    }
                    return "";
                }
            },
            {
                key: "delgroup",
                build: async (p) => {
                    await onebotApi(bot, "set_group_leave", { group_id: p[1] });
                    return "";
                }
            },
            {
                key: "delfriend",
                build: async (p) => {
                    await onebotApi(bot, "delete_friend", { user_id: p[1] });
                    return "";
                }
            },
            {
                key: "airecord",
                build: async (p) => {
                    await onebotApi(bot, "send_group_ai_record", {
                        character: p[2],
                        group_id: groupId,
                        text: p[1]
                    });
                    return "";
                }
            },
            {
                key: "totext",
                build: async (p) => {
                    const result = await onebotApi(bot, "voice_msg_to_text", { message_id: p[1] });
                    return result.text;
                }
            },
            {
                key: "ocr",
                build: async (p) => {
                    const result = await onebotApi(bot, "ocr_image", { image: p.slice(1).join(".") });
                    return result.data.texts[0].text;
                }
            },
            {
                key: "info",
                build: async (p) => {
                    const info = await onebotApi(bot, "get_status", {});
                    console.log(info);
                    return info.stat[p[1]] ?? "";
                }
            },
            { key: "get", build: async (p) => await req(p.slice(1).join(".")) },
            {
                key: "coin",
                build: async (p) => await coins_operation(p[5], p[4], p[3], p[1], p[2])
            },
            {
                key: "msg",
                build: async (p) => {
                    const msg = await onebotApi(bot, "get_msg", { message_id: p[1]});
                    const cfg = await fileCacheIO(CONFIG_FILE_PATH, "r");
                    const transmsg = transMessage(msg.message ?? [], cfg);
                    if (p[2] == "true") {
                        return transmsg.replace(/\[/g, "【").replace(/\]/g, "】");
                    }
                    return transmsg;
                }
            },
            {
                key: "getvalue",
                build: async (p) => {
                    return await getValue(p.slice(1).join("."));
                }
            },
            { key: "eval", build: async (p) => await eval(p.slice(1).join(".")) },
            {
                key: "random",
                build: (p) => String(Math.floor(Math.random() * (+p[1] - (+p[2]) + 1)) + +p[2])
            },
            { key: "divide", build: async (p) => { console.log(`${alltext} ${p[1]}`) } },
            {
                key: "cooldown",
                build: async (p) => {
                    const cooltime = await coins_operation(selfId, groupId, userId, `0`, `COOLDOWN:${global_lexicon_ids[selfId].hit}`);
                    if (cooltime!=="0" && ((+cooltime - Date.now())>0)) {
                        // 冷却中
                        return "VanError";
                    } else {
                        await coins_operation(selfId, groupId, userId, `||${Date.now()+(+p[1]*1000)}||`, `COOLDOWN:${global_lexicon_ids[selfId].hit}`);
                        return "";
                    }
                }
            },
            {
                key: "cooldowntime",
                build: async (p) => {
                    const cooltime = await coins_operation(selfId, groupId, userId, `0`, `COOLDOWN:${global_lexicon_ids[selfId].hit}`);
                    return String((+cooltime - Date.now())/1000);
                }
            },
            {
                key: "lexselect",
                build: async (p) => {
                    await coins_operation(selfId, "0", selfId, `||${p[1]}||`, `SELECT`);
                    return "";
                }
            },
            {
                key: "lexused",
                build: async (p) => {
                    await coins_operation(selfId, groupId, "0", `||${p[1]}||`, `USED`);
                    return "";
                }
            },
            {
                key: "lexselecting",
                build: async (p) => {
                    return await coins_operation(selfId, "0", selfId, `0`, `SELECT`);
                }
            },
            {
                key: "lexusing",
                build: async (p) => {
                    return await coins_operation(selfId, groupId, "0", `0`, `USED`);
                }
            },
            {
                key: "msgerror",
                build: async (p) => {
                    global_error_reply[selfId].text = p[1];
                    return "";
                }
            },
            {
                key: "judge",
                build: async (p) => {
                    let judge_result = await judge(p.slice(1).join("."));
                    if (judge_result) {
                        return "";
                    } else {
                        return "VanError";
                    }
                }
            },
            {
                key: "task",
                build: async (p) => {
                    let taskData = await fileCacheIO(path.join(PLUGIN_DATA, "task.json"), "r")
                    await controlTasks(taskData)
                    return "任务已启动";
                }
            },
            { key: "botid", build: () => String(event.raw.sender?.nickname ?? "") },
            { key: "selfid", build: () => String(event.selfId ?? "") },
            { key: "userid", build: () => String(event.userId ?? "") },
            { key: "groupid", build: () => String(event.groupId ?? "") },
            { key: "username", build: () => String(event.raw.sender?.nickname ?? "") },
            { key: "usercard", build: () => String((event.raw.sender?.card || event.raw.sender?.nickname) ?? "") },
            { key: "userrole", build: () => String(event.raw.sender?.role ?? "") },
            { key: "groupname", build: () => String(event.raw.group_name ?? "") },
            { key: "msgid", build: () => String(event.raw.message_id ?? "") },
            { key: "time", build: () => String(event.raw.time ?? "") },
            { key: "newline", build: () => "\n" },
            { key: "lexid", build: () => String(global_lexicon_ids[selfId].hit) },
            { key: "lextotal", build: () => String(global_lexicon_totals[selfId].count) },
            { key: "sendid", build: () => String(global_message_ids[selfId]?.[event.groupId || event.userId]) },
            {
                key: "lexicon",
                build: async (p) => {
                    let lexSelect = await coins_operation(selfId, "0", selfId, `0`, `SELECT`) as string;
                    lexSelect = lexSelect == "0" ? "default" : lexSelect;
                    if (p[1] == "更新配置") {
                        await fileCacheIO(CONFIG_FILE_PATH, "r", undefined, true);
                        return "重新加载配置成功";
                    }
                    if (p[1] == "重载词库") {
                        const lexPath = path.join(PLUGIN_DATA, selfId, "lexicon", `${lexSelect}.json`);
                        fileCachePool.delete(lexPath);
                        return "词库缓存已清空，下次匹配读取磁盘最新词库";
                    }
                    if (p[1] == "加词") {
                        const key = p[2].replace(/［［/g, "[").replace(/］］/g, "]").replace(/｜｜/g, "|");
                        const reply = p[3].replace(/［［/g, "[").replace(/］］/g, "]").replace(/｜｜/g, "|");
                        const mode = Number(p[4]);
                        const ok = await LexiconManager(selfId, lexSelect, "add", {n:key,r:reply,s:mode})
                        console.log({n:key,r:reply,s:mode});
                        return ok;
                    }
                    if (p[1] == "删词") {
                        const delStr = p[2];
                        const ok = await LexiconManager(selfId, lexSelect, "remove_name", {remove_name: delStr})
                        if (ok) {
                            return ok;
                        } else {
                            return ok;
                        }
                    }
                    if (p[1] == "删id") {
                        const delId = Number(p[2]);
                        const ok = await LexiconManager(selfId, lexSelect, "remove_id", {remove_id:delId})
                        if (ok) {
                            return ok;
                        } else {
                            return ok;
                        }
                    }
                    if (p[1] == "恢复id") {
                        const rid = Number(p[2])
                        const ok = await LexiconManager(selfId, lexSelect, "restore_all",{})
                        if (ok) {
                            return ok;
                        } else {
                            return ok;
                        }
                    }
                    if (p[1] == "查id") {
                        const qid = p[2]
                        if (qid) {
                            const list = await LexiconManager(selfId, lexSelect, "look_id", {look_id:qid}) as string;
                            return list.replace(/\[/g, "【").replace(/\]/g, "】")
                        } else {
                            const item = await LexiconManager(selfId, lexSelect, "look_id", {look_id:"1-1000"}) as string;
                            return item.replace(/\[/g, "【").replace(/\]/g, "】")
                        }
                    }
                    if (p[1] == "查词") {
                        const qid = p[2]
                        const list = await LexiconManager(selfId, lexSelect, "look_name", {look_name:qid})
                        return list;
                    }
                }
            },
        ];

        for (const item of typeMap) {
            const typeKey = item.key;
            const tplObj = getTypeTemplate(typeKey);
            const nameTemplate = tplObj.name;
            const keyTemplate = buildKeyTemplate(typeKey, tplObj);

            let params = await matchTemplateGetParams(nameTemplate, text);
            if (params === null) {
                params = await matchTemplateGetParams(keyTemplate, text);
            }

            if (params === null) continue;

            const filledParams: string[] = [];
            for (const key of Object.keys(tplObj)) {
                const matchP = key.match(/^p(\d+)$/);
                if (!matchP) continue;
                const idx = Number(matchP[1]);
                const captureVal = params[idx];
                if (captureVal && captureVal.trim() !== "") {
                    filledParams[idx] = captureVal;
                } else {
                    filledParams[idx] = await resolveValue(tplObj[key]);
                }
            }
            const result = await item.build(filledParams);
            return result;
        }
        return null;
    }
    async function replaceInner(s: string): Promise<string> {
        const match = s.match(/\[([^\[\]]+)\]/);
        if (!match) return s;
        const fullNode = match[0];
        const innerText = match[1];
        const opResult = await operation(innerText, s);
        if (opResult == "VanError") {
            console.log(global_error_reply[selfId].text);
            return String(global_error_reply[selfId].text);
        }
        if (opResult === null) {
            const before = s.substring(0, match.index!);
            const after = s.substring(match.index! + fullNode.length);
            return before + fullNode + await replaceInner(after);
        }
        const replaceStr = typeof opResult === "object" && opResult !== null && "type" in opResult
            ? `{{NODE:${btoa(JSON.stringify(opResult))}}}`
            : String(opResult);
        return replaceInner(s.replace(fullNode, replaceStr));
    }
    global_error_reply[selfId] ??= {};
    global_error_reply[selfId].text = "";

    const reg = /\[分段\.\d+\]/
    if (reg.test(inputStr)) {
        await clauseTask(inputStr, bot, event);
        inputStr = "";
    }

    const candidates = inputStr.split(RANDOM_SEP);
    const selectedText = candidates[Math.floor(Math.random() * candidates.length)];
    const processedRaw = await replaceInner(selectedText);
    const resultArr: MsgSegment[] = [];
    const tokenReg = /(\{\{NODE:.+?\}\}|[^{]+)/g;
    for (const token of processedRaw.matchAll(tokenReg)) {
        const content = token[0];
        if (content.startsWith("{{NODE:")) {
            const jsonStr = atob(content.replace("{{NODE:", "").replace("}}", ""));
            resultArr.push(JSON.parse(jsonStr));
        } else if (content.trim()) {
            resultArr.push({ type: "text", data: { text: content } });
        }
    }
    return resultArr;
}

// 接收发送消息处理
export async function handleAllEvent(
    eventName: string,
    event: BotEvent,
    bot: BaseAdapter
): Promise<void> {
    try {
        const raw = event.raw;
        if (raw.status === "ok") return;

        const selfId = String(event.selfId);
        const uid = String(event.userId);
        const gid = String(event.groupId);

        const cfg = await fileCacheIO(CONFIG_FILE_PATH, "r") as any;
        const ownerList = cfg.OWNER_LIST || [];
        const masterId = await coins_operation(selfId, "0", "0", `0`, `MASTER`);
        const masterList = masterId == "0" ? [] : masterId.split(",");

        if (cfg.showRawLog) {
            console.log(event);
        }

        const isMsgEvent = eventName === "group_message" || eventName === "private_message" || raw.post_type === "message_sent";
        if (isMsgEvent) {
            const transStr = transMessage(event.message ?? [], cfg);
            const logType = +gid ? "群聊" : "私聊";
            const targetId = String(+gid || +uid);
            botLog(selfId, "<-", logType, targetId, transStr);

            // 主人号配置
            if (masterList.length == 0) {
                if (transStr.startsWith('#设置主人号 ')) {
                    let masterid = transStr.replace("#设置主人号 ", "");
                    await coins_operation(selfId, "0", "0", `||${masterid}||`, `MASTER`);
                    await onebotApi(bot, "send_msg", { user_id: uid, message: `已成功将${masterid}设置为主人号` })
                    botLog(selfId, "<-", "插件", selfId, `配置主人号成功，当前主人号: ${masterid}`);
                    return;
                } else {
                    botLog(selfId, "<-", "插件", selfId, `配置主人号指令：#设置主人号 你的QQ号(当前用户id: ${uid})(多个主人号用英文逗号隔开)`);
                }
            }

            let lexUsed = await coins_operation(selfId, targetId, "0", `0`, `USED`);
            lexUsed = lexUsed == "0" ? "default" : lexUsed;

            const matchResult = await LexiconManager(selfId, lexUsed, "get", { value: transStr }) as any;
            if (matchResult && matchResult !== "") {
                const rawReplyList = matchResult.replyList;
                const rawReply = rawReplyList[Math.floor(Math.random() * rawReplyList.length)];
                let tempText = rawReply;

                // 替换 [n.x] 捕获占位
                if (matchResult.capture !== false) {
                    const captureArr = matchResult.capture;
                    for (let i = 0; i < captureArr.length; i++) {
                        tempText = tempText.replaceAll(`[n.${i}]`, captureArr[i]);
                        tempText = tempText.replaceAll(`[n.${i}.t]`, await getValue(captureArr[i]));
                    }
                }

                // 解析标签 → 消息段数组
                const messageSegments = await parseBracketStr(tempText, bot, event);

                try {
                    if (JSON.stringify(messageSegments) === "[]") {
                        botLog(selfId, "<-", "插件", selfId, "空消息");
                    } else {
                        global_message_ids[selfId] ??= {};
                        let sendid;
                        if (+gid) {
                            sendid = await onebotApi(bot, "send_group_msg", { group_id: gid, message: messageSegments }) as { message_id: number };
                        } else {
                            sendid = await onebotApi(bot, "send_private_msg", { user_id: uid, message: messageSegments }) as { message_id: number };
                        }
                        global_message_ids[selfId][targetId] = sendid.message_id;
                    }
                } catch (lexErr) {
                    const msg = `消息发送异常！\nenv: ${logType}\nenvID: ${targetId}\nrobotID: ${selfId}\nevent: ${eventName}\nreceive: ${transStr}\nsend: ${JSON.stringify(messageSegments)}\nerror: ${(lexErr as Error).message}`;
                    if (cfg.errorNotice) {
                        await onebotApi(bot, "send_private_msg", { user_id: ownerList[0], message: msg });
                    } else {
                        botLog(selfId, "<-", "插件", selfId, msg);
                    }
                }
            }

            let lexSelect = await coins_operation(selfId, "0", selfId, `0`, `SELECT`);
            lexSelect = lexSelect == "0" ? "default" : lexSelect;

            // 主人消息处理
            if (masterList.includes(uid)) {
                // 联网导入词库
                const match = transStr.match(/^\[VanBot\](.*?)词库表/);
                if (match) {
                    const lexicon_import_url = cfg.lexicon_import_url;
                    const lexicon_name = match[1]
                    const lexicon_location = path.join(PLUGIN_DATA, selfId, "lexicon", `${lexicon_name}.json`);
                    await LexiconManager(selfId, lexicon_name, "reset_id",{})
                    let trandata = {"varPoolText": transStr.replace(/\\n/g, '\n'), "templateName": lexicon_name};
                    let ndata = JSON.parse(await req(lexicon_import_url, "POST", trandata));
                    let odata = await fileCacheIO(lexicon_location, "r", undefined, true);
                    const map = {} as Record<string, unknown>;
                    odata.work.forEach((v: Record<string, unknown>) => map[Object.keys(v)[0]] = v);
                    ndata.work.forEach((v: Record<string, unknown>) => map[Object.keys(v)[0]] = v);
                    const work = Object.values(map);
                    await fileCacheIO(lexicon_location, "w", JSON.stringify({work}, null, 4));
                    await LexiconManager(selfId, lexicon_name, "reset_id",{})
                    await coins_operation(selfId, "0", selfId, `||${lexicon_name}||`, `SELECT`)
                    let lexicon_config = await req(`http://bot.ziyi.asia/JSver/data/${lexicon_name}.json`);
                    await fileCacheIO(CONFIG_FILE_PATH, "w", lexicon_config);
                    await onebotApi(bot, +gid ? "send_group_msg" : "send_private_msg", {
                        group_id: gid,
                        user_id: uid,
                        message: [{type:"text",data:{text:lexicon_name + "词库配置成功"}}]
                    })
                    botLog(selfId, "<-", "插件", targetId, lexicon_name + "词库配置成功")
                }

                if (transStr === "#更新配置") {
                    await fileCacheIO(CONFIG_FILE_PATH, "r", undefined, true)
                    await onebotApi(bot, +gid ? "send_group_msg" : "send_private_msg", {
                        group_id: gid,
                        user_id: uid,
                        message: [{type:"text",data:{text:"重新加载配置成功"}}]
                    })
                    botLog(selfId, "<-", "插件", targetId, "配置文件已重新加载")
                }
            }

            // 最高所有者消息处理
            if (masterList.includes(uid)) {
                // 重整词库
                if(transStr === "#重整词库"){
                    const res = await LexiconManager(selfId, lexSelect, "reset_id",{})
                    await onebotApi(bot, +gid ? "send_group_msg" : "send_private_msg", {
                        group_id: gid,
                        user_id: uid,
                        message: [{type:"text",data:{text:res}}]
                    })
                }
                // 热更新
                if(transStr === "#更新"){
                    const plugin_path = path.join(ROOT_DIR, "src", "cmd", "keyword.ts");
                    const plugin_code = await req("http://bot.ziyi.asia/JSver/keyword.ts");
                    await fileCacheIO(plugin_path, "w", plugin_code)
                    await onebotApi(bot, gid ? "send_group_msg" : "send_private_msg", {
                        group_id: gid,
                        user_id: uid,
                        message: [{type:"text",data:{text:"更新完成，已自动重启！"}}]
                    })
                }
            }

        } else if (eventName === "notice") {
            const noticeInfo = transNotice(raw, +selfId, cfg);
            botLog(selfId, "<-", "通知", String(noticeInfo.targetId), noticeInfo.text);
        } else if (eventName === "meta_event") {
            const metaInfo = transMeta(raw, +selfId, cfg);
            botLog(selfId, "<-", "通知", String(metaInfo.targetId), metaInfo.text);
        }
    } catch (err) {
        console.error(`[事件处理异常]`, err);
        console.log("异常事件原始数据：", event.raw);
    }
}

// 时间解析
function parseHumanTime(
    timeStr: string
): ParseTimeResult {
    const rule = new schedule.RecurrenceRule();
    rule.tz = "Asia/Shanghai";
    const s = timeStr.trim();

    const sixNumMatch = s.match(/^(\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/);
    if (sixNumMatch) {
        const [, year, month, date, hour, minute, second] = sixNumMatch.map(Number);
        if (year !== 0) rule.year = year;
        if (month !== 0) rule.month = month - 1;
        if (date !== 0) rule.date = date;
        if (hour !== 0) rule.hour = hour;
        if (minute !== 0) rule.minute = minute;
        if (second !== 0) rule.second = second;
        return rule;
    }

    if (/^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
        return new Date(s.replace(/\./g, "-"));
    }
    if (/^\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
        const [md, hms] = s.split(" ");
        const [month, date] = md.split(".").map(Number);
        const [hour, minute, second] = hms.split(":").map(Number);
        Object.assign(rule, { month: month - 1, date, hour, minute, second });
        return rule;
    }
    if (/^W\d{1} \d{2}:\d{2}:\d{2}$/.test(s)) {
        const [weekStr, hms] = s.split(" ");
        const weekDay = parseInt(weekStr.replace("W", ""), 10);
        const [hour, minute, second] = hms.split(":").map(Number);
        Object.assign(rule, { dayOfWeek: weekDay, hour, minute, second });
        return rule;
    }
    if (/^\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
        const [dateStr, hms] = s.split(" ");
        const [hour, minute, second] = hms.split(":").map(Number);
        Object.assign(rule, { date: Number(dateStr), hour, minute, second });
        return rule;
    }
    if (/^\d{2}:\d{2}:\d{2}$/.test(s)) {
        const [hour, minute, second] = s.split(":").map(Number);
        Object.assign(rule, { hour, minute, second });
        return rule;
    }
    if (/^\d{2}:\d{2}$/.test(s)) {
        const [minute, second] = s.split(":").map(Number);
        Object.assign(rule, { minute, second });
        return rule;
    }

    const sec = parseInt(s, 10);
    if (!Number.isNaN(sec)) {
        return { intervalSec: sec };
    }

    throw new Error(`无法解析 time：${timeStr}`);
}

// 定时&循环 任务执行
async function controlTasks(
    taskObj: TaskListObj, action: "start" | "stop" = "start"
): Promise<void> {
    Object.values(jobPool).forEach((job) => {
        if ("cancel" in job && typeof job.cancel === "function") job.cancel();
        if ("timer" in job) clearInterval(job.timer);
    });
    Object.keys(jobPool).forEach(k => delete jobPool[k]);
    Object.keys(taskCache).forEach(k => delete taskCache[k]);
    console.log("已清空旧定时任务 & 任务缓存");

    if (action === "stop") {
        console.log("所有任务已关闭");
        return;
    }

    const list = taskObj.work ?? [];
    const cfg = await fileCacheIO(CONFIG_FILE_PATH, "r") as any;
    const webui_url = cfg.webui_url;
    const webui_status = cfg.webui_status;
    if (webui_url && webui_status) {
        list.push({
            time: "5",
            botId: "102046363",
            groupId: "952188078",
            userId: "804019614",
            msg: `[get.${webui_url}102046363.txt]`,
            cache: true
        
        } as any);
    }
    
    list.forEach((item) => {
        const cacheKey = JSON.stringify({ botId: item.botId, groupId: item.groupId, userId: item.userId, msg: item.msg, time: item.time });
        const parsed = parseHumanTime(item.time);

        const taskFn = async () => {
        try {
            const taskBot = get_bot(item.botId) ?? ({} as BaseAdapter)
            const taskEvent: BotEvent = {
            botId: item.botId,
            selfId: item.botId,
            userId: item.userId ?? 0,
            groupId: item.groupId  ?? 0,
            message: [],
            postType: "meta_event",
            raw: {},
            }
            const newRes = await parseBracketStr(item.msg, taskBot, taskEvent);

            if (item.cache) {
                // 对象不能比较 作者知识+1
                if (JSON.stringify(taskCache[cacheKey]) === JSON.stringify(newRes)) {
                    console.log("禁止回复");
                    return;
                }
            taskCache[cacheKey] = newRes;
            }
            //触发任务
            await onebotApi(taskBot, +item.groupId ? "send_group_msg" : "send_private_msg", {
                group_id: item.groupId,
                user_id: item.userId,
                message: newRes
            })
        } catch (e) {
            console.error("任务执行异常：", e);
        }
        };

        let job: PoolJob;
        if (parsed instanceof Date) {
            job = schedule.scheduleJob(parsed, taskFn);
        } else if ("intervalSec" in parsed) {
            job = { timer: setInterval(taskFn, parsed.intervalSec * 1000) };
        } else {
            job = schedule.scheduleJob(parsed, taskFn);
        }
        const key = `task_${item.botId}_${item.groupId}_${item.userId}_${item.msg}`;
        jobPool[key] = job;
        console.log(`创建任务 key:${key} time:${item.time} cache:${!!item.cache}`);
    });
}