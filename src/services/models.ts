import { create } from 'zustand'
import { API_ORIGIN, request } from './api/client.js'

/**
 * 服务端扩展能力：联网工具（deepseek_web_search / deepseek_read_url）与自动会话标题。
 * 声明模型不支持的能力会被服务端直接拒绝（400），所以请求前必须按模型裁剪。
 */
export type ModelCapabilities = {
  /** 可以在请求中声明联网工具；为 false 时历史里的服务端工具块也不能回传 */
  serverTools: boolean
  /** 可以在请求中传 title.enabled 自动生成标题 */
  title: boolean
}

/** GET /models 返回的模型元数据，只保留本应用用到的字段 */
export type ModelInfo = {
  id: string
  /** 展示名称，接口未提供时为 null */
  name: string | null
  contextWindow: number | null
  maxOutputTokens: number | null
  /** 支持的输入模态，如 text、image */
  inputModalities: string[]
  /** 开启思考时支持的推理强度档位，按服务端给出的顺序 */
  effortLevels: string[]
  defaultEffort: string | null
  /** 联网工具与自动标题的可用性 */
  capabilities: ModelCapabilities
}

/**
 * 内置能力表：接口的 api_capabilities 只声明 system_prompt_update，
 * 没有说明联网工具和标题是否可用，因此按模型维护。
 * deepseek-v4-pro 声明 deepseek_web_search / deepseek_read_url 或 title.enabled
 * 都会被服务端拒绝，所以两项能力都不可用。
 */
const BUILT_IN_CAPABILITIES: Record<string, ModelCapabilities> = {
  'deepseek-flash': { serverTools: true, title: true },
  'deepseek-v4-pro': { serverTools: false, title: false },
}

/** 未收录的模型按支持处理：接入服务支持扩展能力时不会被误关 */
const DEFAULT_CAPABILITIES: ModelCapabilities = { serverTools: true, title: true }

/** 运行时降级：服务端明确拒绝过扩展能力后，本页面内不再为该模型声明。 */
const restrictedModels = new Map<string, ModelCapabilities>()

/** 按 id 取能力：精确匹配优先，其次按前缀归入同一模型家族（兼容日期与实验后缀） */
export const modelCapabilities = (id: string): ModelCapabilities => {
  const builtIn =
    BUILT_IN_CAPABILITIES[id] ??
    Object.entries(BUILT_IN_CAPABILITIES).find(([known]) => id.startsWith(known))?.[1] ??
    DEFAULT_CAPABILITIES
  const restricted = restrictedModels.get(id)
  return restricted
    ? {
        serverTools: builtIn.serverTools && restricted.serverTools,
        title: builtIn.title && restricted.title,
      }
    : builtIn
}

/**
 * 记录服务端拒绝的能力，只做收窄。
 * 实际收窄时返回 true，调用方据此决定是否重发请求；返回 false 表示已经收窄过，避免重复重试。
 */
export const restrictModelCapabilities = (
  id: string,
  patch: Partial<ModelCapabilities>
): boolean => {
  const current = modelCapabilities(id)
  const next: ModelCapabilities = {
    serverTools: current.serverTools && patch.serverTools !== false,
    title: current.title && patch.title !== false,
  }
  if (next.serverTools === current.serverTools && next.title === current.title) {
    return false
  }
  restrictedModels.set(id, next)
  return true
}

/** 拉取失败或尚未拉取时的内置列表；能力字段按官方文档固定 */
export const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'deepseek-flash',
    name: null,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: ['text', 'image'],
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
    capabilities: modelCapabilities('deepseek-flash'),
  },
  {
    id: 'deepseek-v4-pro',
    name: null,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: ['text'],
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
    capabilities: modelCapabilities('deepseek-v4-pro'),
  },
]

/** 模型列表缓存 5 分钟，避免每次打开面板都请求 */
const CACHE_TTL = 5 * 60 * 1000

type ModelCatalogState = {
  models: ModelInfo[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  fetchedAt: number
  error: string | null
}

export const useModelCatalog = create<ModelCatalogState>(() => ({
  models: [],
  status: 'idle',
  fetchedAt: 0,
  error: null,
}))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const toModelInfo = (value: unknown): ModelInfo | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    return null
  }
  const effort = isRecord(value.effort) ? value.effort : null
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name ? value.name : null,
    contextWindow: asNumber(value.context_window),
    maxOutputTokens: asNumber(value.max_output_tokens),
    inputModalities: asStrings(value.input_modalities),
    effortLevels: effort ? asStrings(effort.supported_levels) : [],
    defaultEffort:
      effort && typeof effort.default_level === 'string' ? effort.default_level : null,
    capabilities: modelCapabilities(value.id),
  }
}

/** 解析 { object: 'list', data: [...] }；无法识别的条目直接丢弃 */
export const parseModelList = (value: unknown): ModelInfo[] => {
  const list = isRecord(value) && Array.isArray(value.data) ? value.data : []
  return list.flatMap((item) => {
    const model = toModelInfo(item)
    return model ? [model] : []
  })
}

/**
 * 拉取模型列表：force 忽略缓存；并发请求共用同一次拉取。
 * 失败时保留旧列表（若有），只记录错误，界面回退到内置列表。
 */
export const loadModels = async (apiKey: string, force = false): Promise<void> => {
  const state = useModelCatalog.getState()
  if (!apiKey || state.status === 'loading') {
    return
  }
  if (!force && state.status === 'ready' && Date.now() - state.fetchedAt < CACHE_TTL) {
    return
  }
  useModelCatalog.setState({ status: 'loading', error: null })
  try {
    const response = await request(`${API_ORIGIN}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const models = parseModelList(await response.json())
    if (models.length === 0) {
      throw new Error('empty model list')
    }
    useModelCatalog.setState({ models, status: 'ready', fetchedAt: Date.now(), error: null })
  } catch (error) {
    useModelCatalog.setState({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** 面板实际展示的列表：拉到过就用接口结果，否则用内置两项 */
export const visibleModels = (models: ModelInfo[]): ModelInfo[] =>
  models.length > 0 ? models : FALLBACK_MODELS

/**
 * 找不到时按内置能力表兜底，再找不到视为纯文本模型。
 * 能力按当前状态重新计算：服务端拒绝过某项能力后，界面要立刻同步。
 */
export const findModel = (id: string, models: ModelInfo[]): ModelInfo => {
  const model = visibleModels(models).find((item) => item.id === id)
  return model
    ? { ...model, capabilities: modelCapabilities(id) }
    : {
        id,
        name: null,
        contextWindow: null,
        maxOutputTokens: null,
        inputModalities: ['text'],
        effortLevels: [],
        defaultEffort: null,
        capabilities: modelCapabilities(id),
      }
}

/** 选择推理强度时的候选档位；接口没有给出时用服务端通用三档 */
export const effortOptions = (model: ModelInfo): string[] =>
  model.effortLevels.length > 0 ? model.effortLevels : ['low', 'high', 'max']
