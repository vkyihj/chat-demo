import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setSessionParams, resetSessionParams, useChatStore } from '../../services/chat/store.js'
import {
  effortOptions,
  findModel,
  loadModels,
  useModelCatalog,
  visibleModels,
} from '../../services/models.js'
import {
  DEFAULT_PARAMS,
  resolveParams,
  STOP_SEQUENCE_LIMIT,
  STOP_SEQUENCE_MAX_LENGTH,
  type ChatParams,
} from '../../services/params.js'
import { setParams, updateParams, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './ParamsPanel.module.css'

const formatCount = (value: number): string => value.toLocaleString()

const ToggleChip = ({
  active,
  label,
  disabled = false,
  onClick,
}: {
  active: boolean
  label: string
  disabled?: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    className={clsx(styles.chip, active && styles.chipActive)}
    aria-pressed={active}
    disabled={disabled}
    onClick={onClick}
  >
    {label}
  </button>
)

/** 数字输入：编辑期间保留原始文本，失焦或回车时校验并夹到允许范围 */
const NumberField = ({
  label,
  value,
  placeholder,
  min,
  max,
  disabled = false,
  hint,
  onCommit,
}: {
  label: string
  value: number | null
  placeholder: string
  min: number
  max: number
  disabled?: boolean
  hint?: ReactNode
  onCommit: (value: number | null) => void
}) => {
  const [draft, setDraft] = useState(value === null ? '' : String(value))

  useEffect(() => {
    setDraft(value === null ? '' : String(value))
  }, [value])

  const commit = () => {
    const text = draft.trim()
    if (!text) {
      onCommit(null)
      return
    }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) {
      setDraft(value === null ? '' : String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    onCommit(clamped)
    setDraft(String(clamped))
  }

  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={styles.input}
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          }
        }}
      />
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </label>
  )
}

/**
 * 聊天框下方的模型与参数面板：编辑当前对话的覆盖值；
 * 在欢迎页（没有会话）编辑的是新对话的全局默认值。
 */
export const ParamsPanel = ({
  open,
  sessionId,
  onClose,
}: {
  open: boolean
  sessionId: string | null
  onClose: () => void
}) => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const defaults = useSettings((state) => state.params)
  const override = useChatStore((state) =>
    sessionId === null ? undefined : state.sessionCache[sessionId]?.params
  )
  const models = useModelCatalog((state) => state.models)
  const status = useModelCatalog((state) => state.status)
  const error = useModelCatalog((state) => state.error)
  const params = useMemo(() => resolveParams(defaults, override), [defaults, override])
  const model = findModel(params.model, models)
  const [stopText, setStopText] = useState(params.stopSequences.join('\n'))

  useEffect(() => {
    setStopText(params.stopSequences.join('\n'))
  }, [params.stopSequences])

  useEffect(() => {
    if (open) {
      void loadModels(apiKey ?? '')
    }
  }, [open, apiKey])

  if (!open) {
    return null
  }

  const update = (patch: Partial<ChatParams>) => {
    if (sessionId === null) {
      updateParams(patch)
    } else {
      setSessionParams(sessionId, patch)
    }
  }

  const commitStopSequences = () => {
    const lines = stopText
      .split('\n')
      .map((line) => line.trim().slice(0, STOP_SEQUENCE_MAX_LENGTH))
      .filter(Boolean)
      .slice(0, STOP_SEQUENCE_LIMIT)
    update({ stopSequences: lines })
    setStopText(lines.join('\n'))
  }

  const modelOptions = visibleModels(models).map((item) => ({
    value: item.id,
    label: item.name ?? item.id,
  }))
  if (!modelOptions.some((option) => option.value === params.model)) {
    modelOptions.unshift({ value: params.model, label: params.model })
  }

  const modelHint = [
    model.contextWindow !== null
      ? t('paramsContextWindow', { count: formatCount(model.contextWindow) })
      : null,
    model.maxOutputTokens !== null
      ? t('paramsMaxOutput', { count: formatCount(model.maxOutputTokens) })
      : null,
    model.inputModalities.includes('image')
      ? t('paramsSupportsImages')
      : t('paramsNoImages'),
  ]
    .filter(Boolean)
    .join(' · ')

  const temperatureDisabled = params.thinking
  const effortLevels = effortOptions(model)
  // 模型不支持联网工具与自动标题时，这两类能力在请求里会被裁掉，界面同步置灰
  const { serverTools: serverToolsSupported, title: titleSupported } = model.capabilities

  return (
    <Modal
      title={t('paramsTitle')}
      closable
      onClose={onClose}
      className={styles.dialog}
      mainClassName={styles.main}
    >
      <div className={styles.scope}>
        {sessionId === null ? t('paramsScopeDefault') : t('paramsScopeSession')}
      </div>

      <section className={styles.group}>
        <div className={styles.groupHeader}>
          <span>{t('paramsModelGroup')}</span>
          <IconButton
            size="m"
            tone="primary"
            icon={<IconRefreshOutline16 />}
            tooltip={t('paramsRefreshModels')}
            disabled={!apiKey || status === 'loading'}
            onClick={() => void loadModels(apiKey ?? '', true)}
          />
        </div>
        <Select
          ariaLabel={t('paramsModel')}
          value={params.model}
          options={modelOptions}
          onChange={(value) => update({ model: value, effort: null })}
        />
        <div className={styles.hint}>{modelHint}</div>
        {status === 'loading' ? <div className={styles.hint}>{t('paramsLoadingModels')}</div> : null}
        {status === 'error' ? (
          <div className={styles.warn}>{t('paramsModelsFallback', { error: error ?? '' })}</div>
        ) : null}
      </section>

      <section className={styles.group}>
        <div className={styles.groupHeader}>
          <span>{t('paramsCapabilitiesGroup')}</span>
        </div>
        <div className={styles.toggles}>
          <ToggleChip
            active={params.thinking}
            label={t('paramsThinking')}
            onClick={() => update({ thinking: !params.thinking })}
          />
          <ToggleChip
            active={serverToolsSupported && params.search}
            label={t('paramsSearch')}
            disabled={!serverToolsSupported}
            onClick={() => update({ search: !params.search })}
          />
          <ToggleChip
            active={serverToolsSupported && params.readUrl}
            label={t('paramsReadUrl')}
            disabled={!serverToolsSupported}
            onClick={() => update({ readUrl: !params.readUrl })}
          />
        </div>
        <div className={styles.hint}>{t('paramsThinkingHint')}</div>
        {serverToolsSupported && titleSupported ? null : (
          <div className={styles.warn}>
            {serverToolsSupported ? null : t('paramsServerToolsUnsupported')}
            {!serverToolsSupported && !titleSupported ? ' ' : null}
            {titleSupported ? null : t('paramsTitleUnsupported')}
          </div>
        )}
        {params.thinking ? (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('paramsEffort')}</span>
            <Select
              ariaLabel={t('paramsEffort')}
              value={params.effort ?? ''}
              options={[
                { value: '', label: t('paramsEffortAuto') },
                ...effortLevels.map((level) => ({ value: level, label: level })),
              ]}
              onChange={(value) => update({ effort: value || null })}
            />
            <span className={styles.hint}>
              {model.defaultEffort
                ? t('paramsEffortDefault', { level: model.defaultEffort })
                : t('paramsEffortHint')}
            </span>
          </div>
        ) : null}
      </section>

      <section className={styles.group}>
        <div className={styles.groupHeader}>
          <span>{t('paramsSamplingGroup')}</span>
        </div>
        <div className={styles.grid}>
          <NumberField
            label={t('paramsMaxTokens')}
            value={params.maxTokens}
            placeholder={t('paramsMaxTokensPlaceholder')}
            min={1}
            max={model.maxOutputTokens ?? 1_000_000}
            hint={
              model.maxOutputTokens !== null
                ? t('paramsMaxTokensHint', { count: formatCount(model.maxOutputTokens) })
                : t('paramsMaxTokensAuto')
            }
            onCommit={(value) => update({ maxTokens: value })}
          />
          <NumberField
            label={t('paramsTemperature')}
            value={params.temperature}
            placeholder={t('paramsAutoPlaceholder')}
            min={0}
            max={2}
            disabled={temperatureDisabled}
            hint={
              temperatureDisabled ? t('paramsTemperatureThinking') : t('paramsTemperatureHint')
            }
            onCommit={(value) => update({ temperature: value })}
          />
          <NumberField
            label={t('paramsTopP')}
            value={params.topP}
            placeholder={t('paramsAutoPlaceholder')}
            min={0.01}
            max={1}
            hint={params.thinking ? t('paramsTopPThinking') : t('paramsTopPHint')}
            onCommit={(value) => update({ topP: value })}
          />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('paramsSafety')}</span>
            <Select
              ariaLabel={t('paramsSafety')}
              value={params.safetyLevel}
              options={[
                { value: 'high', label: t('paramsSafetyHigh') },
                { value: 'low', label: t('paramsSafetyLow') },
              ]}
              onChange={(value) => update({ safetyLevel: value === 'low' ? 'low' : 'high' })}
            />
            <span className={styles.hint}>{t('paramsSafetyHint')}</span>
          </div>
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('paramsStop')}</span>
          <textarea
            className={clsx(styles.input, styles.textarea)}
            rows={2}
            value={stopText}
            placeholder={t('paramsStopPlaceholder')}
            onChange={(event) => setStopText(event.target.value)}
            onBlur={commitStopSequences}
          />
          <span className={styles.hint}>{t('paramsStopHint')}</span>
        </label>
      </section>

      <div className={styles.footer}>
        <Button
          variant="outlined"
          size="m"
          onClick={() => {
            if (sessionId === null) {
              setParams(DEFAULT_PARAMS)
            } else {
              resetSessionParams(sessionId)
            }
            setStopText('')
          }}
        >
          {t('paramsReset')}
        </Button>
        {sessionId === null ? null : (
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              setParams(params)
              showToast(t('paramsSavedDefault'))
            }}
          >
            {t('paramsSaveDefault')}
          </Button>
        )}
        <Button size="m" onClick={onClose}>
          {t('paramsDone')}
        </Button>
      </div>
    </Modal>
  )
}
