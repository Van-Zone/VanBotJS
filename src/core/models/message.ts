export type MsgSegmentType = "text" | "at" | "image" | "face" | "video" | "reply"

export interface IMsgSegment {
  type: MsgSegmentType
  data: Record<string, string | number>

  toOneBot11(): Record<string, any>
}

export class MessageSegment implements IMsgSegment {
  type: MsgSegmentType
  data: Record<string, string | number>

  constructor(type: MsgSegmentType, data: Record<string, string | number>) {
    this.type = type
    this.data = data
  }

  toOneBot11() {
    return { type: this.type, data: this.data }
  }

  static text(text: string): MessageSegment {
    return new MessageSegment("text", { text })
  }
  static at(qq: number | string): MessageSegment {
    return new MessageSegment("at", { qq: String(qq) })
  }
  static image(file: string): MessageSegment {
    return new MessageSegment("image", { file })
  }
  static face(id: number): MessageSegment {
    return new MessageSegment("face", { id: String(id) })
  }
}

// 类型别名导出
export type MessageChain = MessageSegment[]