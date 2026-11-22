import { create } from 'zustand'
import { API_ORIGIN, request } from './api/client.js'

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
  },
  {
    id: 'deepseek-v4-pro',
    name: null,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: ['text'],
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
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

/** 找不到时按内置能力表兜底，再找不到视为纯文本模型 */
export const findModel = (id: string, models: ModelInfo[]): ModelInfo =>
  visibleModels(models).find((model) => model.id === id) ?? {
    id,
    name: null,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: ['text'],
    effortLevels: [],
    defaultEffort: null,
  }

/** 选择推理强度时的候选档位；接口没有给出时用服务端通用三档 */
export const effortOptions = (model: ModelInfo): string[] =>
  model.effortLevels.length > 0 ? model.effortLevels : ['low', 'high', 'max']
