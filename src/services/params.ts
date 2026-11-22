/**
 * 请求参数：全局默认存 localStorage，单个会话可覆盖，每条回答保存当时的快照。
 * 与 /anthropic/v1/messages 的对应关系见 store.ts 的 createRequestBody。
 */
export type ChatParams = {
  /** 模型 ID，来自 GET /models；内置默认 deepseek-flash */
  model: string
  /** 深度思考：映射 thinking.type */
  thinking: boolean
  /** 推理强度：映射 output_config.effort；null 交给服务端按模型默认档位决定 */
  effort: string | null
  /** 联网搜索：是否声明 deepseek_web_search */
  search: boolean
  /** 阅读链接：是否声明 deepseek_read_url */
  readUrl: boolean
  /** 输出上限，映射 max_tokens；null 不传，使用服务端默认值 */
  maxTokens: number | null
  /** 采样温度，映射 temperature；思考模式下服务端固定为 1 */
  temperature: number | null
  /** 核采样，映射 top_p */
  topP: number | null
  /** 停止序列，映射 stop_sequences，最多 16 条 */
  stopSequences: string[]
  /** 安全审核，映射 safety_check.level */
  safetyLevel: 'low' | 'high'
}

/** 服务端限制：stop_sequences 最多 16 条、每条 512 字节以内 */
export const STOP_SEQUENCE_LIMIT = 16
export const STOP_SEQUENCE_MAX_LENGTH = 512

export const DEFAULT_PARAMS: ChatParams = {
  model: 'deepseek-flash',
  thinking: false,
  effort: null,
  search: false,
  readUrl: true,
  maxTokens: null,
  temperature: null,
  topP: null,
  stopSequences: [],
  safetyLevel: 'high',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 越界的数值视为未设置，避免把服务端会拒绝的值发出去 */
const numberInRange = (
  value: unknown,
  min: number,
  max: number,
  integer = false
): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return null
  }
  return integer ? Math.round(value) : value
}

/** 核采样要求大于 0 且不超过 1 */
const topPInRange = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : null

const normalizeStopSequences = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const sequence = item.trim()
    if (!sequence || seen.has(sequence)) {
      continue
    }
    seen.add(sequence)
    result.push(sequence.slice(0, STOP_SEQUENCE_MAX_LENGTH))
    if (result.length >= STOP_SEQUENCE_LIMIT) {
      break
    }
  }
  return result
}

/** 把 localStorage、导入数据或用户输入统一成合法参数；缺省项回落到默认值 */
export const normalizeParams = (value: unknown): ChatParams => {
  if (!isRecord(value)) {
    return DEFAULT_PARAMS
  }
  return {
    model:
      typeof value.model === 'string' && value.model.trim()
        ? value.model.trim()
        : DEFAULT_PARAMS.model,
    thinking: value.thinking === true,
    effort: typeof value.effort === 'string' && value.effort ? value.effort : null,
    search: value.search === true,
    readUrl: value.readUrl !== false,
    maxTokens: numberInRange(value.maxTokens, 1, 1_000_000, true),
    temperature: numberInRange(value.temperature, 0, 2),
    topP: topPInRange(value.topP),
    stopSequences: normalizeStopSequences(value.stopSequences),
    safetyLevel: value.safetyLevel === 'low' ? 'low' : 'high',
  }
}

/** 全局默认 + 会话覆盖 → 本次生效参数 */
export const resolveParams = (
  defaults: ChatParams,
  override?: Partial<ChatParams> | null
): ChatParams => (override ? normalizeParams({ ...defaults, ...override }) : defaults)

/** 基于当前参数生成补丁后的完整参数 */
export const patchParams = (base: ChatParams, patch: Partial<ChatParams>): ChatParams =>
  normalizeParams({ ...base, ...patch })
