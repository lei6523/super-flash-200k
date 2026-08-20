/**
 * context-compiler — structured working-memory compiler for the
 * super-flash-200k preset.
 *
 * The plugin does NOT replace dsh's durable session log. The session log is
 * the raw_log and is never truncated or deleted. This plugin maintains a
 * small sidecar state per session:
 *
 *   - memory cards    : one atom of goal/constraint/preference/decision/
 *                       todo/artifact/failure/fact/warning
 *   - task_state      : the shortest recoverable working state
 *   - decision_log    : choices + reason + status
 *   - artifact_index  : files / commands / important outputs
 *   - snapshots       : persisted context packages (recoverable)
 *   - raw_log index   : append-only pointers into the session log
 *
 * Extension points used:
 *   - session/event    : incremental capture (user, assistant, tool, todo)
 *   - turn/end         : incremental compression / merge / scoring
 *   - agent/pre-step   : inject a durable plugin user message
 *   - tools/pre-execute: guard cc://context://archive:// URIs
 *   - ctx.tools        : context_search / read / pin / remember /
 *                        supersede / forget / report
 *
 * Persistence is a JSON file under
 *   $DSH_HOME/context-compiler/sessions/<session-id>.json
 * plus project/user-scope memory under
 *   $DSH_HOME/context-compiler/memory/<project-hash>.json
 */

import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'context-compiler'

/** Host-plane services this plugin reads at event time. */
export const inject = ['tools', 'sessions', 'tokenMeter']

const STATE_VERSION = 1
const SNAPSHOT_SOURCE_KIND = 'context-compiler'
const MEMORY_URI_RE = /\b(?:cc|context|archive):\/\/[^\s"']+/i

/** Hard-constraint / preference signal words. */
const EMPHASIS_RE = /(?:必须|务必|一定要|禁止|不能|不要|千万别|never|must not|do not|don't|remember|记住|以后都|从此以后|关键|最重要的是|硬性|always|以后都要)/i

/** Sentence-level decision signals. */
const DECISION_RE = /(?:决定|选定|选择|采用|方案定为|改为|改用|不再使用|放弃|最终方案|用\s+\S+\s+实现|will use|decided|choose|switch to|final approach)/i

/** Failure signals in tool results. */
const FAILURE_RE = /(?:Traceback|Exception|Error:|error:|FAILED|failed|No such file|command not found|not found|Permission denied|ETIMEDOUT|ECONNREFUSED|EACCES|ENOENT|SyntaxError|TypeError|ReferenceError|AssertionError|\bFAIL\b|失败|报错|异常)/

const DEFAULT_CONFIG = {
  injectMaxChars: 12000,
  evidenceMaxChars: 1600,
  cardMaxChars: 1200,
  recentTurns: 4,
  topMemories: 8,
  minImportance: 0.3,
  softCompressAt: 80000,
  stateSnapshotAt: 120000,
  strongCompressAt: 160000,
  hardRebuildAt: 185000,
  targetInputTokens: 150000,
}

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/** Memory-card kind vocabulary from the design. */
const CARD_KINDS = new Set([
  'goal', 'constraint', 'preference', 'decision', 'todo',
  'artifact', 'failure', 'fact', 'warning',
])

/** Statuses allowed by the design. */
const CARD_STATUSES = new Set(['active', 'superseded', 'disputed', 'archived'])

function resolveConfig(source) {
  if (source === undefined) source = {}
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${name}: unknown config key(s) ${unknown.join(', ')} — allowed: ${[...ALLOWED_KEYS].sort().join(', ')}`)
  }
  const config = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(config)) {
    if (source[key] !== undefined) config[key] = source[key]
  }
  for (const key of ['injectMaxChars', 'evidenceMaxChars', 'cardMaxChars', 'softCompressAt', 'stateSnapshotAt', 'strongCompressAt', 'hardRebuildAt', 'targetInputTokens']) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) {
      throw new TypeError(`${name}: ${key} must be a positive integer`)
    }
  }
  for (const key of ['recentTurns', 'topMemories']) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) {
      throw new TypeError(`${name}: ${key} must be a positive integer`)
    }
  }
  if (typeof config.minImportance !== 'number' || !Number.isFinite(config.minImportance) || config.minImportance < 0 || config.minImportance > 1) {
    throw new TypeError(`${name}: minImportance must be a number in [0, 1]`)
  }
  return config
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function stableHash(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function nowIso() {
  return new Date().toISOString()
}

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`
}

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function isActive(card) {
  return card && card.status === 'active'
}

function tokenEstimate(text) {
  return Math.ceil(String(text ?? '').length / 4)
}

/** Walk every text-ish block nested in a message content list. */
function flattenContent(content, out = []) {
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'tool-call') {
      if (typeof block.name === 'string') out.push(block.name)
      if (typeof block.arguments === 'string') out.push(block.arguments)
    } else if (Array.isArray(block.content)) flattenContent(block.content, out)
  }
  return out
}

function eventText(event) {
  if (!event || !event.data) return ''
  const data = event.data
  switch (event.type) {
    case 'user/message':
      return flattenContent(data.content).join('\n')
    case 'assistant/message': {
      const message = data.message ?? data
      return flattenContent(message.content).join('\n')
    }
    case 'tool/call':
      return `${data.name}\n${data.arguments ?? ''}`
    case 'tool/result': {
      const message = data.message ?? data
      return flattenContent(message.content).join('\n')
    }
    case 'todo/write':
      return Array.isArray(data.todos) ? data.todos.map((t) => t.content ?? t.text ?? JSON.stringify(t)).join('\n') : ''
    default:
      return ''
  }
}

function eventSourceKind(event) {
  const data = event?.data
  if (event?.type === 'user/message') return data?.source?.kind
  if (event?.type === 'tool/result') return data?.message?.source?.kind
  return undefined
}

function firstErrorLine(text) {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    if (FAILURE_RE.test(line)) return line.slice(0, 400)
  }
  return truncate(lines[0] || text, 400)
}

/** Extract a likely file path from serialized tool arguments. */
function filePathFromArguments(name, raw) {
  if (raw === undefined || raw === null) return ''
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return ''
    }
  }
  if (!args || typeof args !== 'object') return ''
  for (const key of ['path', 'file_path', 'filePath', 'target', 'target_file', 'filename', 'command']) {
    if (typeof args[key] === 'string' && args[key].length > 0) return args[key]
  }
  return ''
}

function makeCard(fields) {
  const id = fields.id ?? `mem_${randomUUID()}`
  const now = nowIso()
  return {
    id,
    kind: fields.kind ?? 'fact',
    content: truncate(String(fields.content ?? ''), fields.maxChars ?? 1200),
    scope: fields.scope ?? 'session',
    status: fields.status ?? 'active',
    importance: Number(fields.importance ?? 0.5),
    confidence: Number(fields.confidence ?? 0.5),
    evidence: [...new Set(fields.evidence ?? [])],
    created_at: fields.created_at ?? now,
    updated_at: now,
    expires_at: fields.expires_at ?? null,
    supersedes: [...new Set(fields.supersedes ?? [])],
    keywords: fields.keywords ?? [],
    pinned: fields.pinned === true,
  }
}

function freshState(sessionId) {
  return {
    version: STATE_VERSION,
    sessionId,
    projectKey: '',
    updated_at: nowIso(),
    cards: [],
    task_state: {
      goal: '',
      current_request: '',
      progress: '',
      unresolved: [],
      blockers: [],
      last_action: '',
      updated_at: nowIso(),
    },
    decision_log: [],
    artifact_index: [],
    snapshots: [],
    raw_log: [],
    forgotten: [],
    last_processed_seq: 0,
    last_turn: 0,
    injection: {
      last_turn: 0,
      last_compaction_seq: -1,
      snapshot_counter: 0,
      message_id: '',
    },
  }
}

function normalizeState(raw, sessionId) {
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return freshState(sessionId)
  const state = freshState(sessionId)
  for (const key of ['cards', 'decision_log', 'artifact_index', 'snapshots', 'raw_log', 'forgotten']) {
    if (Array.isArray(raw[key])) state[key] = raw[key]
  }
  if (raw.task_state && typeof raw.task_state === 'object') Object.assign(state.task_state, raw.task_state)
  if (raw.injection && typeof raw.injection === 'object') Object.assign(state.injection, raw.injection)
  if (Number.isSafeInteger(raw.last_processed_seq)) state.last_processed_seq = raw.last_processed_seq
  if (Number.isSafeInteger(raw.last_turn)) state.last_turn = raw.last_turn
  if (typeof raw.projectKey === 'string') state.projectKey = raw.projectKey
  return state
}

function projectKey(cwd) {
  if (!cwd) return 'default'
  return stableHash(normalize(cwd))
}

class JsonStore {
  constructor(rootDir) {
    this.rootDir = rootDir
    this.cache = new Map()
    this.tails = new Map()
  }

  sessionPath(sessionId) {
    return path.join(this.rootDir, 'sessions', `${safeName(sessionId)}.json`)
  }

  projectPath(key) {
    return path.join(this.rootDir, 'memory', `${safeName(key)}.json`)
  }

  async readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch (error) {
      if (error && error.code === 'ENOENT') return fallback
      throw error
    }
  }

  async writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  }

  load(sessionId) {
    const key = `session:${sessionId}`
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key))
    const tail = this.tails.get(key) ?? Promise.resolve()
    const next = tail
      .catch(() => {})
      .then(async () => {
        const state = normalizeState(await this.readJson(this.sessionPath(sessionId), null), sessionId)
        this.cache.set(key, state)
        return state
      })
    this.tails.set(key, next)
    next.catch(() => {})
    return next
  }

  save(state) {
    const key = `session:${state.sessionId}`
    this.cache.set(key, state)
    const write = async () => {
      await this.writeJson(this.sessionPath(state.sessionId), state)
    }
    const tail = (this.tails.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(write)
      .catch((error) => {
        console.error(`[${name}] failed to persist session state ${state.sessionId}:`, error?.message ?? error)
      })
    this.tails.set(key, tail)
    return tail
  }

  loadProject(pKey) {
    const key = `project:${pKey}`
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key))
    const next = Promise.resolve()
      .then(() => this.readJson(this.projectPath(pKey), { cards: [] }))
      .then((raw) => {
        const value = { cards: Array.isArray(raw.cards) ? raw.cards : [] }
        this.cache.set(key, value)
        return value
      })
      .catch((error) => {
        console.error(`[${name}] failed to load project memory ${pKey}:`, error?.message ?? error)
        return { cards: [] }
      })
    this.cache.set(key, next)
    return next
  }

  saveProject(pKey, value) {
    return this.writeJson(this.projectPath(pKey), value).catch((error) => {
      console.error(`[${name}] failed to persist project memory ${pKey}:`, error?.message ?? error)
    })
  }
}

/** BM25-ish lexical retrieval with importance and recency boost, then MMR. */
function searchCandidates(candidates, query, opts = {}) {
  const words = normalize(query).split(/[^a-z0-9_\u4e00-\u9fff]+/).filter(Boolean)
  const terms = []
  for (const word of words) {
    if (/[\u4e00-\u9fff]/.test(word) && word.length >= 3) {
      for (let i = 0; i < word.length - 1; i += 1) terms.push(word.slice(i, i + 2))
    } else if (word.length <= 32) {
      terms.push(word)
    }
  }
  const boost = (item) => {
    const text = `${item.content ?? ''} ${(item.keywords ?? []).join(' ')}`
    const hay = normalize(text)
    let score = 0
    for (const term of terms) {
      if (term.length === 0) continue
      const hits = hay.split(term).length - 1
      if (hits > 0) score += hits * (1 + Math.log(1 + term.length / 4))
      if ((item.id ?? '').toLowerCase().includes(term)) score += 1.5
    }
    score += Number(item.importance ?? 0) * 2
    score += Number(item.pinned === true ? 2 : 0)
    if (item.updated_at) {
      const age = Math.max(0, Date.now() - Date.parse(item.updated_at))
      score += Math.max(0, 1 - age / (1000 * 60 * 60 * 24 * 7)) * 1.5
    }
    return score
  }
  const ranked = candidates
    .map((item) => ({ item, score: boost(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  const picked = []
  while (picked.length < (opts.limit ?? 8) && ranked.length > 0) {
    let best = null
    let bestIndex = -1
    for (let i = 0; i < ranked.length; i += 1) {
      const candidate = ranked[i]
      const similarity = picked.reduce((max, prior) => Math.max(max, overlapRatio(candidate.item.content, prior.item.content)), 0)
      const mmr = 0.65 * candidate.score - 0.35 * similarity * 10
      if (best === null || mmr > best.mmr) {
        best = { ...candidate, mmr }
        bestIndex = i
      }
    }
    if (best === null) break
    picked.push(best)
    ranked.splice(bestIndex, 1)
  }
  return picked
}

function overlapRatio(left, right) {
  const a = normalize(left)
  const b = normalize(right)
  if (a.length === 0 || b.length === 0) return 0
  const tokens = new Set(a.split(/\s+/))
  let hits = 0
  for (const token of b.split(/\s+/)) if (tokens.has(token)) hits += 1
  return hits / Math.max(1, Math.min(tokens.size, b.split(/\s+/).length))
}

/** Assemble one section list for the context package. */
function buildPackageSections(state, config, session, currentMessages = []) {
  const sections = []
  const active = (card) => isActive(card) && !state.forgotten.includes(card.id)
  const goal = state.cards.find((card) => active(card) && card.kind === 'goal')
  const claimedRequest = currentMessages
    .filter((message) => message?.source?.kind === 'user')
    .map((message) => flattenContent(message.content).join('\n'))
    .join('\n')
  const constraints = state.cards.filter((card) => active(card) && card.kind === 'constraint').sort((a, b) => b.importance - a.importance)
  const preferences = state.cards.filter((card) => active(card) && card.kind === 'preference').sort((a, b) => b.importance - a.importance)
  const decisions = state.decision_log.filter((entry) => entry.status === 'active').slice(-6)
  const todos = state.cards.filter((card) => active(card) && card.kind === 'todo').sort((a, b) => b.importance - a.importance).slice(0, 10)
  const failures = state.cards.filter((card) => active(card) && card.kind === 'failure').sort((a, b) => b.importance - a.importance).slice(0, 6)

  if (goal) sections.push({ title: 'Current Goal', text: goal.content })
  const currentRequest = claimedRequest.trim() || state.task_state.current_request
  if (currentRequest) sections.push({ title: 'Current Request', text: truncate(currentRequest, 900) })
  if (constraints.length > 0) {
    sections.push({
      title: 'Hard Constraints',
      text: constraints.map((card) => `${card.id}: ${card.content}${card.evidence.length ? ` [${card.evidence.join(', ')}]` : ''}`).join('\n'),
    })
  }
  if (preferences.length > 0) {
    sections.push({
      title: 'User Preferences / Standing Instructions',
      text: preferences.map((card) => `${card.id}: ${card.content}`).join('\n'),
    })
  }
  if (decisions.length > 0) {
    sections.push({
      title: 'Active Decisions',
      text: decisions.map((entry) => `${entry.id}: ${entry.content}${entry.status !== 'active' ? ` (${entry.status})` : ''}`).join('\n'),
    })
  }
  if (todos.length > 0) {
    sections.push({ title: 'Open Todos', text: todos.map((card) => `${card.id}: ${card.content}`).join('\n') })
  }
  if (failures.length > 0) {
    sections.push({
      title: 'Recent Failures / Things Already Tried',
      text: failures.map((card) => `${card.id}: ${card.content}`).join('\n'),
    })
  }
  const shown = new Set([goal?.id, ...constraints.map((c) => c.id), ...preferences.map((c) => c.id), ...todos.map((c) => c.id), ...failures.map((c) => c.id)])
  const memories = state.cards
    .filter((card) => active(card) && !shown.has(card.id) && card.importance >= config.minImportance && card.kind !== 'todo')
    .sort((a, b) => b.importance - a.importance)
    .slice(0, config.topMemories)
  if (memories.length > 0) {
    sections.push({
      title: 'Relevant Memories',
      text: memories.map((card) => `${card.id} [${card.kind}, importance ${card.importance.toFixed(2)}]: ${card.content}${card.evidence.length ? `\n  Evidence: ${card.evidence.join(', ')}` : ''}`).join('\n'),
    })
  }
  const evidence = topEvidence(state, memories, constraints, failures, config)
  if (evidence.length > 0) {
    sections.push({ title: 'Relevant Raw Evidence', text: evidence.map((item) => `[${item.ref}]\n${item.text}`).join('\n\n') })
  }
  sections.push({
    title: 'Available Archives',
    text: [
      `- raw session log: every original message/tool result remains in the session log (never deleted)`,
      `- compiler store: ${state.cards.length} memory cards, ${state.artifact_index.length} artifacts, ${state.snapshots.length} snapshots`,
      '- use context_search / context_read to pull the original evidence instead of guessing',
    ].join('\n'),
  })
  const audit = auditState(state)
  if (audit.warnings.length > 0) {
    sections.push({
      title: 'Compression Audit',
      text: `status=${audit.ok ? 'ok' : 'warnings'}\n${audit.warnings.map((line) => `- ${line}`).join('\n')}`,
    })
  }
  sections.push({
    title: 'Instruction',
    text: 'Use this snapshot as recovered working context. If a detail is uncertain, request or retrieve the original evidence instead of guessing.',
  })
  return sections
}

function auditState(state) {
  const warnings = []
  const active = state.cards.filter((card) => isActive(card) && !state.forgotten.includes(card.id))
  if (!active.some((card) => card.kind === 'goal') && state.task_state.current_request === '') {
    warnings.push('no active goal and no current request')
  }
  for (const card of active) {
    if (['constraint', 'failure', 'decision'].includes(card.kind) && card.confidence < 0.6) {
      warnings.push(`${card.id} is a ${card.kind} with low confidence ${card.confidence.toFixed(2)}; treat as uncertain, not fact`)
    }
    if (card.kind === 'constraint' && card.evidence.length === 0) {
      warnings.push(`${card.id} constraint has no evidence pointer`)
    }
    if (card.status !== 'active') warnings.push(`${card.id} has non-active status ${card.status}`)
  }
  for (const entry of state.decision_log) {
    if (entry.status !== 'active') warnings.push(`${entry.id} decision is ${entry.status}, not current`)
  }
  return {
    ok: warnings.length === 0,
    warnings,
    checked_at: nowIso(),
  }
}

function topEvidence(state, memories, constraints, failures, config) {
  const candidates = []
  const push = (item, ref) => {
    const text = truncate(item.content ?? '', config.evidenceMaxChars)
    if (text.trim()) candidates.push({ ref, text, importance: Number(item.importance ?? 0) })
  }
  for (const card of [...constraints, ...failures, ...memories]) {
    const wantsUserText = ['goal', 'constraint', 'preference', 'fact'].includes(card.kind)
    const raw = state.raw_log.filter((entry) =>
      card.evidence?.includes(`turn_${entry.turn}`)
      && (!wantsUserText || entry.sourceKind === 'user'),
    )
    for (const entry of raw.slice(-3)) push(entry, `turn_${entry.turn}, seq_${entry.seq}`)
  }
  return candidates
    .sort((a, b) => b.importance - a.importance)
    .filter((item, index, all) => all.findIndex((other) => other.text === item.text) === index)
    .slice(0, 5)
}

function renderPackage(state, config, session, currentMessages = []) {
  const sections = buildPackageSections(state, config, session, currentMessages)
  const header = ['[Context Compiler Snapshot]', `state_version=${state.version} session=${state.sessionId} updated=${state.updated_at}`, '']
  let budget = config.injectMaxChars
  const chosen = []
  for (const section of sections) {
    const text = section.text
    if (text.length === 0) continue
    const block = `${section.title}:\n${text}`
    if (block.length > budget && chosen.length > 0) {
      const keep = Math.max(200, budget)
      chosen.push(`${section.title}:\n${truncate(text, keep)}`)
      break
    }
    chosen.push(block)
    budget -= block.length
  }
  const text = [...header, ...chosen].join('\n\n')
  return {
    text,
    estimatedTokens: tokenEstimate(text),
    sections: sections.map((section) => section.title),
  }
}

export function apply(ctx, config) {
  const opts = resolveConfig(config)
  const store = new JsonStore(path.join(dshHome(), 'context-compiler'))
  const pending = new Map()
  const ensureTails = new Map()
  const processing = new Map()
  const lastCompactionSeqs = new Map()

  const queueEvents = (session, event) => {
    if (event.type === 'turn/end') {
      const batch = pending.get(session.id) ?? []
      pending.delete(session.id)
      scheduleTurnCompression(session, batch)
      return
    }
    const batch = pending.get(session.id) ?? []
    batch.push(event)
    pending.set(session.id, batch)
  }

  const scheduleTurnCompression = (session, events) => {
    const existing = processing.get(session.id)
    if (existing !== undefined) {
      const chained = existing.catch(() => {}).then(() => processTurnSafely(session, events))
      processing.set(session.id, chained)
      chained.finally(() => {
        if (processing.get(session.id) === chained) processing.delete(session.id)
      })
      return chained
    }
    const task = processTurnSafely(session, events)
    processing.set(session.id, task)
    task.finally(() => {
      if (processing.get(session.id) === task) processing.delete(session.id)
    })
    return task
  }

  const processTurnSafely = async (session, events) => {
    try {
      await processTurn(session, events)
    } catch (error) {
      console.error(`[${name}] turn compression failed for ${session.id}:`, error?.message ?? error)
    }
  }

  const ensureState = (session) => {
    const existing = ensureTails.get(session.id)
    if (existing !== undefined) return existing
    const task = (async () => {
      const state = await store.load(session.id)
      const events = Array.from(session.events ?? [])
      const lastSeq = events.length > 0 ? events[events.length - 1].seq ?? 0 : 0
      if (state.last_processed_seq < lastSeq) {
        const missing = events.filter((event) => (event.seq ?? 0) > state.last_processed_seq && event.type !== 'turn/end')
        if (missing.length > 0) {
          captureEvents(state, missing, session)
          state.last_processed_seq = lastSeq
          await store.save(state)
        }
      }
      if (state.projectKey === '') {
        state.projectKey = projectKey(session.header?.cwd)
        await store.save(state)
      }
      await importProjectMemory(state, session)
      return state
    })()
    ensureTails.set(session.id, task)
    task.finally(() => ensureTails.delete(session.id))
    return task
  }

  async function processTurn(session, events) {
    if (events.length === 0) return
    const state = await store.load(session.id)
    captureEvents(state, events, session)
    const last = events[events.length - 1]
    state.last_processed_seq = Math.max(state.last_processed_seq, last.seq ?? 0)
    state.last_turn = Math.max(state.last_turn, last.data?.turn ?? state.last_turn)
    updateTaskState(state, session, events)
    await store.save(state)
  }

  async function importProjectMemory(state, session) {
    const pKey = state.projectKey || projectKey(session.header?.cwd)
    const project = await store.loadProject(pKey)
    const imported = project.cards
      .filter((card) => isActive(card) && ['project', 'user', 'global'].includes(card.scope))
      .filter((card) => !state.cards.some((mine) => mine.id === card.id))
      .filter((card) => !state.forgotten.includes(card.id))
    if (imported.length > 0) {
      state.cards.push(...imported.map((card) => ({ ...card })))
      await store.save(state)
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'compaction/end') {
        lastCompactionSeqs.set(session.id, Math.max(lastCompactionSeqs.get(session.id) ?? -1, event.seq ?? 0))
      }
      queueEvents(session, event)
    } catch (error) {
      console.error(`[${name}] session/event capture failed:`, error?.message ?? error)
    }
  })

  // ── extraction ────────────────────────────────────────────────────────────

  function captureEvents(state, events, session) {
    const latestTurn = events.reduce((max, event) => Math.max(max, event.data?.turn ?? 0), 0)
    const calls = new Map()
    for (const event of events) {
      const seq = event.seq ?? 0
      const turn = event.data?.turn ?? latestTurn
      if (seq <= state.last_processed_seq) continue
      if (eventSourceKind(event) === SNAPSHOT_SOURCE_KIND) continue
      switch (event.type) {
        case 'tool/call':
          calls.set(event.data.callId, event)
          appendRawLog(state, event, 'tool call', latestTurn)
          break
        case 'tool/result': {
          const call = calls.get(event.data.message?.source?.callId)
          captureToolResult(state, call, event, latestTurn)
          appendRawLog(state, event, 'tool result', latestTurn)
          break
        }
        case 'user/message': {
          const sourceKind = eventSourceKind(event)
          if (sourceKind === 'user') captureUserMessage(state, event, latestTurn, session)
          appendRawLog(state, event, sourceKind === 'user' ? 'user message' : 'injected message', latestTurn, sourceKind)
          break
        }
        case 'assistant/message': {
          captureAssistantMessage(state, event, latestTurn)
          appendRawLog(state, event, 'assistant message', latestTurn)
          break
        }
        case 'todo/write': {
          captureTodos(state, event, latestTurn)
          appendRawLog(state, event, 'todo list', latestTurn)
          break
        }
        default:
          break
      }
    }
  }

  function appendRawLog(state, event, label, turn, sourceKind = '') {
    const text = truncate(eventText(event), opts.evidenceMaxChars)
    if (text.trim().length === 0) return
    const entry = {
      seq: event.seq ?? 0,
      type: event.type,
      turn,
      label,
      text,
      sourceKind,
      time: event.time ?? null,
    }
    state.raw_log.push(entry)
    if (state.raw_log.length > 400) state.raw_log.splice(0, state.raw_log.length - 400)
  }

  function captureUserMessage(state, event, turn, session) {
    const text = eventText(event)
    if (text.trim().length === 0) return
    state.task_state.current_request = truncate(text, opts.cardMaxChars)
    const emphatic = EMPHASIS_RE.test(text)
    const isFirstGoal = state.cards.every((card) => !isActive(card) || card.kind !== 'goal')
    if (!emphatic && !isFirstGoal) return
    const kind = emphatic && /(?:不要|禁止|不能|千万别|must not|do not|don't)/i.test(text)
      ? 'constraint'
      : emphatic ? 'preference' : 'goal'
    const content = text
    const card = makeCard({
      kind,
      content,
      scope: emphatic && /(?:以后都|记住|从此以后|always)/i.test(text) ? 'user' : 'session',
      importance: scoreImportance(state, kind, text, turn, emphatic),
      confidence: emphatic ? 0.95 : isFirstGoal ? 0.85 : 0.5,
      evidence: [`turn_${turn}`],
      keywords: keywordsOf(text),
    })
    mergeCard(state, card)
    if (card.kind === 'goal') state.task_state.goal = card.content
  }

  function captureAssistantMessage(state, event, turn) {
    const text = eventText(event)
    if (text.trim().length === 0) return
    for (const sentence of splitSentences(text)) {
      if (!DECISION_RE.test(sentence)) continue
      const content = truncate(sentence.trim(), opts.cardMaxChars)
      if (content.length < 8) continue
      const entry = {
        id: `dec_${randomUUID()}`,
        content,
        reason: '',
        alternatives: [],
        status: 'active',
        evidence: [`turn_${turn}`],
        created_at: nowIso(),
        updated_at: nowIso(),
        importance: scoreImportance(state, 'decision', content, turn, false),
        confidence: 0.6,
      }
      if (!state.decision_log.some((prior) => normalize(prior.content) === normalize(entry.content))) {
        state.decision_log.push(entry)
        mergeCard(state, makeCard({
          kind: 'decision',
          content,
          importance: entry.importance,
          confidence: entry.confidence,
          evidence: entry.evidence,
        }))
      }
    }
  }

  function captureToolResult(state, call, resultEvent, turn) {
    const text = eventText(resultEvent)
    if (text.trim().length === 0) return
    const toolName = call?.data?.name ?? resultEvent.data?.message?.source?.callId ?? 'tool'
    const failed = resultEvent.data?.error !== undefined || FAILURE_RE.test(text)
    const evidence = [`turn_${turn}`]
    if (failed) {
      const card = makeCard({
        kind: 'failure',
        content: `${toolName} failed: ${firstErrorLine(text)}`,
        importance: scoreImportance(state, 'failure', text, turn, true),
        confidence: 0.95,
        evidence,
        keywords: keywordsOf(`${toolName} ${firstErrorLine(text)}`),
      })
      mergeCard(state, card)
      state.task_state.blockers = [card.content, ...state.task_state.blockers].slice(0, 6)
      return
    }
    const filePath = call ? filePathFromArguments(toolName, call.data.arguments) : ''
    if (filePath && /(?:write|edit|apply_patch|create|replace|patch|str_replace)/i.test(toolName)) {
      const card = makeCard({
        kind: 'artifact',
        content: `${toolName} ${filePath}`,
        importance: scoreImportance(state, 'artifact', filePath, turn, false),
        confidence: 0.8,
        evidence,
        keywords: [toolName, ...keywordsOf(filePath)],
      })
      mergeCard(state, card)
      state.artifact_index.push({ id: card.id, tool: toolName, path: filePath, evidence, updated_at: nowIso() })
    }
    state.task_state.last_action = `${toolName}: ${firstErrorLine(text)}`
  }

  function captureTodos(state, event, turn) {
    const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
    for (const card of state.cards) {
      if (card.kind === 'todo' && card.status === 'active') card.status = 'superseded'
    }
    for (const todo of todos) {
      const content = String(todo.content ?? todo.text ?? '').trim()
      if (content.length === 0) continue
      const card = makeCard({
        kind: 'todo',
        content,
        status: todo.status === 'completed' || todo.completed ? 'archived' : 'active',
        importance: scoreImportance(state, 'todo', content, turn, todo.priority === 'high' || todo.status === 'in_progress'),
        confidence: 0.9,
        evidence: [`turn_${turn}`],
        keywords: keywordsOf(content),
      })
      mergeCard(state, card)
    }
  }

  function splitSentences(text) {
    return String(text).split(/(?<=[.!?。！？])\s+|\n+/).filter((part) => part.trim().length > 0)
  }

  function keywordsOf(text) {
    const words = normalize(text).split(/[^a-z0-9_\u4e00-\u9fff]+/).filter((word) => word.length > 1)
    const seen = new Set()
    const out = []
    for (const word of words) {
      if (seen.has(word)) continue
      seen.add(word)
      out.push(word)
      if (out.length >= 8) break
    }
    return out
  }

  function mergeCard(state, card) {
    const key = `${card.kind}:${stableHash(normalize(card.content))}`
    const existing = state.cards.find((candidate) => candidate.id === card.id)
      ?? state.cards.find((candidate) => `${candidate.kind}:${stableHash(normalize(candidate.content))}` === key && candidate.status !== 'archived')
    if (existing) {
      existing.updated_at = nowIso()
      existing.importance = Math.max(existing.importance, card.importance)
      existing.confidence = Math.max(existing.confidence, card.confidence)
      existing.evidence = [...new Set([...existing.evidence, ...card.evidence])].slice(-8)
      existing.keywords = [...new Set([...existing.keywords, ...card.keywords])].slice(0, 12)
      return existing
    }
    state.cards.push(card)
    return card
  }

  function scoreImportance(state, kind, text, turn, emphatic) {
    const normalizedText = normalize(text)
    const goalText = normalize(state.task_state.goal || state.task_state.current_request || '')
    const goalTokens = new Set(goalText.split(/[^a-z0-9_\u4e00-\u9fff]+/).filter(Boolean))
    const tokens = normalizedText.split(/[^a-z0-9_\u4e00-\u9fff]+/).filter(Boolean)
    let overlap = 0
    for (const token of tokens) if (goalTokens.has(token)) overlap += 1
    const taskRelevance = tokens.length === 0 ? 0.4 : Math.min(1, overlap / Math.max(4, tokens.length))
    const userEmphasis = emphatic ? 1 : 0.1
    const actionImpact = ['goal', 'constraint', 'decision', 'todo', 'failure'].includes(kind) ? 0.9 : kind === 'artifact' ? 0.6 : 0.3
    const hardType = ['constraint', 'decision', 'failure'].includes(kind) ? 1 : ['todo', 'preference'].includes(kind) ? 0.7 : 0.2
    const reuseValue = ['preference', 'constraint'].includes(kind) ? 0.8 : ['artifact', 'failure', 'decision'].includes(kind) ? 0.5 : 0.2
    const recency = state.last_turn > 0 && turn >= state.last_turn - 2 ? 1 : 0.4
    const score = 0.30 * taskRelevance
      + 0.20 * userEmphasis
      + 0.20 * actionImpact
      + 0.15 * hardType
      + 0.10 * reuseValue
      + 0.05 * recency
    return Math.max(0, Math.min(1, score))
  }

  function updateTaskState(state, session, events) {
    const activeCards = state.cards.filter(isActive)
    const goal = activeCards.find((card) => card.kind === 'goal') ?? activeCards.find((card) => card.kind === 'constraint')
    const todos = activeCards.filter((card) => card.kind === 'todo').slice(0, 10)
    const failures = activeCards.filter((card) => card.kind === 'failure').slice(0, 6)
    const lastUser = [...events].reverse().find((event) => event.type === 'user/message' && eventSourceKind(event) === 'user')
    const lastAction = [...events].reverse().find((event) => event.type === 'tool/result' || event.type === 'assistant/message')
    state.task_state.goal = goal?.content ?? state.task_state.goal ?? ''
    if (lastUser) state.task_state.current_request = truncate(eventText(lastUser), opts.cardMaxChars)
    state.task_state.unresolved = todos.map((card) => card.content)
    state.task_state.blockers = failures.map((card) => card.content)
    state.task_state.last_action = lastAction ? truncate(eventText(lastAction), 400) : state.task_state.last_action
    state.task_state.progress = `${state.last_turn} turn(s) processed; ${state.raw_log.length} raw evidence pointer(s); ${activeCards.length} active card(s)`
    state.task_state.updated_at = nowIso()
  }

  // ── durable snapshot persistence at thresholds ─────────────────────────────

  async function snapshotAtThreshold(state, session, reason) {
    const package_ = renderPackage(state, opts, session)
    state.snapshots.push({
      id: `snap_${randomUUID()}`,
      reason,
      created_at: nowIso(),
      estimated_tokens: package_.estimatedTokens,
      cards: state.cards.filter(isActive).length,
      sections: package_.sections,
      text: package_.text,
    })
    if (state.snapshots.length > 24) state.snapshots.splice(0, state.snapshots.length - 24)
    await store.save(state)
  }

  async function maybeSnapshot(state, session) {
    let tokens = 0
    try {
      tokens = ctx.tokenMeter.measure(session)?.totalTokens ?? 0
    } catch {
      return
    }
    if (tokens >= opts.hardRebuildAt) {
      await snapshotAtThreshold(state, session, 'hard-rebuild')
    } else if (tokens >= opts.strongCompressAt) {
      await snapshotAtThreshold(state, session, 'strong-compress')
    } else if (tokens >= opts.stateSnapshotAt) {
      await snapshotAtThreshold(state, session, 'state-snapshot')
    } else if (tokens >= opts.softCompressAt) {
      await snapshotAtThreshold(state, session, 'soft-compress')
    }
  }

  // ── pre-step context assembly ──────────────────────────────────────────────

  const injected = new Map()

  const snapshotForTurnIsDurable = (session, turn) => {
    const known = injected.get(session.id)
    if (known && known.turn === turn) return true
    const found = Array.from(session.events ?? []).some((event) =>
      event.type === 'user/message'
      && event.data?.source?.kind === SNAPSHOT_SOURCE_KIND
      && event.data?.source?.turn === turn,
    )
    if (found) injected.set(session.id, { turn })
    return found
  }

  ctx.on('agent/pre-step', async ({ agent, messages, step, turn }, next) => {
    const decision = await next()
    try {
      const session = agent?.session
      if (session === undefined || session.header?.delegationDepth > 0) return decision
      const state = await ensureState(session)

      const lastCompactionSeq = lastCompactionSeqs.get(session.id) ?? state.injection.last_compaction_seq ?? -1
      const afterCompaction = lastCompactionSeq > state.injection.last_compaction_seq
      if (afterCompaction) state.injection.last_compaction_seq = lastCompactionSeq
      if (!afterCompaction && step !== 1) return decision
      if (!afterCompaction && snapshotForTurnIsDurable(session, turn)) return decision
      const hasContent = state.cards.some(isActive) || state.task_state.goal || state.task_state.current_request || state.artifact_index.length > 0
      if (!hasContent) return decision

      const package_ = renderPackage(state, opts, session, messages)
      if (package_.text.trim().length === 0) return decision
      state.injection.snapshot_counter += 1
      state.injection.last_turn = turn
      state.injection.message_id = `context-compiler-snapshot-${session.id}-${state.injection.snapshot_counter}`
      await store.save(state)

      injected.set(session.id, { turn })
      const durableMessage = {
        id: state.injection.message_id,
        role: 'user',
        content: [{ type: 'text', text: package_.text }],
        source: {
          kind: SNAPSHOT_SOURCE_KIND,
          form: 'snapshot',
          turn,
          snapshot_counter: state.injection.snapshot_counter,
          estimated_tokens: package_.estimatedTokens,
        },
      }
      return {
        ...decision,
        messages: [...decision.messages, durableMessage],
      }
    } catch (error) {
      console.error(`[${name}] pre-step injection failed:`, error?.message ?? error)
      return decision
    }
  })

  function latestCompactionEndSeq(session) {
    let seq = -1
    for (const event of Array.from(session.events ?? [])) {
      if (event.type === 'compaction/end') seq = Math.max(seq, event.seq ?? 0)
    }
    return seq
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  ctx.tools.register({
    name: 'context_search',
    description: [
      'Search the Context Compiler memory: structured memory cards, decision log, artifacts, and raw evidence excerpts from this session.',
      'Use this instead of re-reading large history when you need an earlier constraint, failed attempt, file path, error, or decision.',
      'The query is augmented with the current goal, open todos, recent failure, and last file automatically.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords to search for' },
        limit: { type: 'integer', description: 'max results, default 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'context_search: no live session for this tool call.' }
      const state = await ensureState(session)
      const query = [String(args.query ?? ''), state.task_state.goal, ...state.task_state.unresolved.slice(0, 3), ...state.task_state.blockers.slice(0, 2)].join(' ')
      const limit = Math.max(1, Math.min(20, Number.isInteger(args.limit) ? args.limit : 8))
      const candidates = [
        ...state.cards.filter((card) => !state.forgotten.includes(card.id)),
        ...state.artifact_index.map((item) => ({ id: item.id, content: `${item.tool} ${item.path}`, kind: 'artifact', importance: 0.7, evidence: item.evidence, updated_at: item.updated_at })),
        ...state.raw_log.map((item) => ({ id: `raw_seq_${item.seq}`, content: item.text, kind: 'raw', importance: 0.45, evidence: [`turn_${item.turn}`], updated_at: item.time ?? nowIso() })),
      ]
      const matches = searchCandidates(candidates, query, { limit })
      if (matches.length === 0) return { text: 'No compiler memory matches. Use context_remember to pin important facts.' }
      const lines = matches.map(({ item, score }) => {
        const kind = item.kind ?? 'record'
        const evidence = Array.isArray(item.evidence) ? item.evidence.join(', ') : ''
        return `${item.id} [${kind}] (score ${score.toFixed(2)}): ${truncate(item.content ?? '', 240)}${evidence ? `\n  evidence: ${evidence}` : ''}`
      })
      return { text: lines.join('\n\n') }
    },
  })

  ctx.tools.register({
    name: 'context_read',
    description: 'Read one compiler memory id (mem_..., dec_..., snap_..., raw_seq_...) or one whole turn (turn_12).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'memory id, or turn_N / seq_N to read original session events' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'context_read: no live session for this tool call.' }
      const id = String(args.id ?? '').trim()
      if (id.startsWith('turn_')) {
        const turn = Number.parseInt(id.slice(5), 10)
        if (!Number.isInteger(turn)) return { text: `invalid turn id: ${id}` }
        return { text: renderTurn(session, turn) }
      }
      if (id.startsWith('seq_')) {
        const seq = Number.parseInt(id.slice(4), 10)
        if (!Number.isInteger(seq)) return { text: `invalid seq id: ${id}` }
        return { text: renderSeq(session, seq) }
      }
      const state = await ensureState(session)
      const card = state.cards.find((item) => item.id === id)
        ?? state.artifact_index.find((item) => item.id === id)
        ?? state.decision_log.find((item) => item.id === id)
        ?? state.snapshots.find((item) => item.id === id)
        ?? state.raw_log.find((item) => `raw_seq_${item.seq}` === id)
      if (card === undefined) return { text: `no compiler record with id ${id}. Use context_search first.` }
      if (typeof card === 'string') return { text: card }
      return { text: JSON.stringify(card, null, 2) }
    },
  })

  ctx.tools.register({
    name: 'context_pin',
    description: 'Pin a compiler memory id as high priority so it is always included in future context snapshots.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'context_pin: no live session.' }
      const state = await ensureState(session)
      const id = String(args.id ?? '')
      for (const list of [state.cards, state.artifact_index, state.decision_log]) {
        const item = list.find((entry) => entry.id === id)
        if (item) {
          item.importance = Math.max(Number(item.importance ?? 0), 0.95)
          item.pinned = true
          await store.save(state)
          return { text: `pinned ${id} (importance ${item.importance}).` }
        }
      }
      return { text: `no compiler record with id ${id}.` }
    },
  })

  ctx.tools.register({
    name: 'context_remember',
    description: 'Explicitly write one atomic memory card. Prefer one fact/constraint/decision/failure per call.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'the atomic fact, constraint, preference, decision, or failure' },
        kind: { type: 'string', enum: [...CARD_KINDS], description: 'memory kind' },
        scope: { type: 'string', enum: ['session', 'project', 'user', 'global'], description: 'default session' },
        importance: { type: 'number', description: '0..1, optional' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'context_remember: no live session.' }
      const state = await ensureState(session)
      const kind = CARD_KINDS.has(args.kind) ? args.kind : 'fact'
      const scope = ['session', 'project', 'user', 'global'].includes(args.scope) ? args.scope : 'session'
      const importance = typeof args.importance === 'number' && Number.isFinite(args.importance) ? Math.max(0, Math.min(1, args.importance)) : 0.9
      const card = makeCard({
        kind,
        content: String(args.content ?? ''),
        scope,
        importance,
        confidence: 1,
        evidence: [`turn_${state.last_turn || latestTurnOf(session)}`],
        keywords: keywordsOf(String(args.content ?? '')),
      })
      if (card.content.length === 0) return { text: 'content must not be empty.' }
      mergeCard(state, card)
      if (scope === 'project' || scope === 'user' || scope === 'global') {
        const pKey = state.projectKey || projectKey(session.header?.cwd)
        const project = await store.loadProject(pKey)
        project.cards = project.cards.filter((item) => item.id !== card.id)
        project.cards.push(card)
        await store.saveProject(pKey, project)
      }
      await store.save(state)
      return { text: `remembered ${card.id} [${card.kind}/${card.scope}].` }
    },
  })

  ctx.tools.register({
    name: 'context_supersede',
    description: 'Mark an old compiler memory superseded and optionally record the replacement content.',
    parameters: {
      type: 'object',
      properties: {
        old_id: { type: 'string' },
        new_content: { type: 'string', description: 'optional replacement content' },
      },
      required: ['old_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'context_supersede: no live session.' }
      const state = await ensureState(session)
      const oldId = String(args.old_id ?? '')
      const old = state.cards.find((card) => card.id === oldId)
      if (!old) return { text: `no compiler memory ${oldId}.` }
      old.status = 'superseded'
      const newContent = String(args.new_content ?? '').trim()
      let newId = null
      if (newContent.length > 0) {
        const card = makeCard({
          kind: old.kind,
          content: newContent,
          scope: old.scope,
          importance: Math.max(old.importance, 0.9),
          confidence: 1,
          evidence: [`turn_${state.last_turn || latestTurnOf(session)}`],
          supersedes: [old.id],
          keywords: keywordsOf(newContent),
        })
        mergeCard(state, card)
        newId = card.id
      }
      await store.save(state)
      return { text: `superseded ${oldId}${newId ? `; replacement ${newId}` : ''}.` }
    },
  })

  ctx.tools.register({
    name: 'context_forget',
    description: 'Permanently remove one compiler memory. This tool call is the explicit user/model request required before deletion.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'context_forget: no live session.' }
      const state = await ensureState(session)
      const id = String(args.id ?? '')
      const removed = state.cards.find((card) => card.id === id)
      const before = state.cards.length + state.decision_log.length + state.artifact_index.length
      state.cards = state.cards.filter((card) => card.id !== id)
      state.decision_log = state.decision_log.filter((entry) => entry.id !== id)
      state.artifact_index = state.artifact_index.filter((entry) => entry.id !== id)
      if (!state.forgotten.includes(id)) state.forgotten.push(id)
      if (removed && ['project', 'user', 'global'].includes(removed.scope)) {
        const pKey = state.projectKey || projectKey(session.header?.cwd)
        const project = await store.loadProject(pKey)
        project.cards = project.cards.filter((card) => card.id !== id)
        await store.saveProject(pKey, project)
      }
      await store.save(state)
      const after = state.cards.length + state.decision_log.length + state.artifact_index.length
      return { text: before === after ? `no compiler record ${id}.` : `forgot ${id}.` }
    },
  })

  ctx.tools.register({
    name: 'context_report',
    description: 'Show what the current context package is composed of (cards, decisions, artifacts, evidence, snapshots).',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return { text: 'context_report: no live session.' }
      const state = await ensureState(session)
      const package_ = renderPackage(state, opts, session)
      const audit = auditState(state)
      const lines = [
        `compiler store: ${state.cards.length} cards (${state.cards.filter(isActive).length} active)`,
        `decision log: ${state.decision_log.length} entries`,
        `artifact index: ${state.artifact_index.length} entries`,
        `raw evidence pointers: ${state.raw_log.length}`,
        `snapshots: ${state.snapshots.length}`,
        `audit: ${audit.ok ? 'ok' : `${audit.warnings.length} warning(s)`}`,
        `current package: ~${package_.estimatedTokens} estimated tokens`,
        `sections: ${package_.sections.join(', ')}`,
        '',
        'Top cards by importance:',
        ...state.cards.filter((card) => !state.forgotten.includes(card.id)).sort((a, b) => b.importance - a.importance).slice(0, 10)
          .map((card) => `${card.id} [${card.kind}/${card.status}] imp=${card.importance.toFixed(2)}: ${truncate(card.content, 120)}`),
        '',
        'Audit warnings:',
        ...(audit.warnings.length > 0 ? audit.warnings.map((line) => `- ${line}`) : ['(none)']),
      ]
      return { text: lines.join('\n') }
    },
  })

  // ── URI protection ─────────────────────────────────────────────────────────

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const text = JSON.stringify({ name: exec?.name, arguments: exec?.arguments ?? exec?.parsedArguments ?? {} })
      if (MEMORY_URI_RE.test(text)) {
        return {
          kind: 'deny',
          reason: 'cc:// / context:// / archive:// identifiers are compiler memory URIs, not filesystem paths. Use context_read (turn_N / seq_N / mem_id) instead of passing them to shell or file tools.',
        }
      }
    } catch {
      // A URI guard failure must never block a tool call.
    }
    return next()
  }, { prepend: true })

  // ── helpers used by tools ──────────────────────────────────────────────────

  function latestTurnOf(session) {
    let turn = 0
    for (const event of Array.from(session.events ?? [])) turn = Math.max(turn, event.data?.turn ?? 0)
    return turn
  }

  function renderTurn(session, turn) {
    const lines = []
    for (const event of Array.from(session.events ?? [])) {
      if ((event.data?.turn ?? 0) !== turn) continue
      if (!['user/message', 'assistant/message', 'tool/call', 'tool/result', 'todo/write'].includes(event.type)) continue
      const text = truncate(eventText(event), opts.evidenceMaxChars)
      if (text.trim()) lines.push(`--- ${event.type} seq=${event.seq ?? 0} ---\n${text}`)
    }
    return lines.length > 0 ? `turn_${turn}:\n\n${lines.join('\n\n')}` : `turn_${turn}: no readable events.`
  }

  function renderSeq(session, seq) {
    for (const event of Array.from(session.events ?? [])) {
      if ((event.seq ?? 0) === seq) {
        return `seq_${seq} ${event.type}:\n\n${truncate(eventText(event), opts.evidenceMaxChars * 3)}`
      }
    }
    return `seq_${seq}: event not found in the live session.`
  }

  // Run threshold snapshots after each turn while the session is being used.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    queueMicrotask(async () => {
      try {
        const state = await ensureState(session)
        await maybeSnapshot(state, session)
      } catch (error) {
        console.error(`[${name}] threshold snapshot failed for ${session.id}:`, error?.message ?? error)
      }
    })
  })
}
