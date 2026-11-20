import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canRenewClaim, closeOverClaim, closeRefusalMessage, isAnotherSessionsClaim, overrideNote, shouldClaimByWorking } from './claim'

describe('closing over a claim', () => {
  const NOW = new Date('2026-11-20T12:00:00.000Z')
  const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString()
  const me = { actorId: 'claude-code · Cal', sessionId: 'session-a' }

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('AC4 closes freely: unclaimed, own claim, a missing session on either side, or a stale lease', () => {
    expect(closeOverClaim(me, { claimed_by: null })).toBeNull()
    expect(closeOverClaim(me, { claimed_by: me.actorId, claimed_session: 'session-a', heartbeat_at: ago(30) })).toBeNull()
    expect(closeOverClaim(me, { claimed_by: me.actorId, claimed_session: null, heartbeat_at: ago(30) })).toBeNull()
    expect(closeOverClaim({ ...me, sessionId: null }, { claimed_by: me.actorId, claimed_session: 'session-b', heartbeat_at: ago(30) })).toBeNull()
    expect(closeOverClaim(me, { claimed_by: 'codex · Cal', claimed_session: 's', heartbeat_at: ago(16 * 60) })).toBeNull()
  })

  it('AC1 refuses another actor, and AC2 another session of the same actor, naming the holder and beat', () => {
    const other = closeOverClaim(me, { claimed_by: 'codex · Cal', claimed_session: 's1', heartbeat_at: ago(120) })
    expect(other).toEqual({ holder: 'codex · Cal', session: 's1', heartbeatAt: ago(120), agoMinutes: 2 })
    expect(closeRefusalMessage(other!)).toMatch(/^Held by codex · Cal, last heartbeat 2m ago\. .*--override-claim/)
    expect(closeOverClaim(me, { claimed_by: me.actorId, claimed_session: 'session-b', heartbeat_at: ago(30) }))
      .toMatchObject({ holder: me.actorId, session: 'session-b' })
  })

  it('AC8 treats 14m59s of silence as live and 15m01s as stale', () => {
    const held = (seconds: number) => closeOverClaim(me, { claimed_by: 'codex · Cal', heartbeat_at: ago(seconds) })
    expect(held(14 * 60 + 59)).not.toBeNull()
    expect(held(15 * 60 + 1)).toBeNull()
  })

  it('AC9 builds the override note from the caller and the stored claim alone', () => {
    expect(overrideNote('claude-code · Cal', { holder: 'codex · Bob', session: 's9' }))
      .toBe('Closed over a live claim: claude-code · Cal overrode codex · Bob (session s9) with --override-claim.')
    expect(overrideNote('claude-code · Cal', { holder: 'codex · Bob', session: null }))
      .not.toContain('session')
  })
})

/**
 * Writing to a task's work log is working on it.
 *
 * 36% of recently closed tasks across CAIRN, OD and QRY were never claimed, so
 * they never showed as In Progress while somebody was on them. The cause is
 * structural: nothing cost anything when it was skipped, so an agent could
 * note, checkpoint and close an unclaimed task and never perceive a
 * difference. The fix is to make the ordinary path produce the right state.
 *
 * The limits matter more than the rule, because each one is a way this could
 * do harm instead.
 */
const agent = { actorType: 'agent' }
const human = { actorType: 'human' }

describe('when working on a task should claim it', () => {
  it('claims an open task nobody holds', () => {
    expect(shouldClaimByWorking(agent, { status: 'backlog' })).toBe(true)
    expect(shouldClaimByWorking(agent, { status: 'todo' })).toBe(true)
    // Started and dropped: taking it back is the point.
    expect(shouldClaimByWorking(agent, { status: 'doing', claimed_by: null })).toBe(true)
  })

  it('never steals from a live holder', () => {
    // Noting on a colleague's task has to stay a note. The lease is stolen
    // only through an explicit claim, where the caller sees the 409.
    expect(shouldClaimByWorking(agent, { status: 'doing', claimed_by: 'openclaw' })).toBe(false)
  })

  it('never reopens finished work', () => {
    // A note on a closed task is a postscript, not a restart.
    expect(shouldClaimByWorking(agent, { status: 'done' })).toBe(false)
    expect(shouldClaimByWorking(agent, { status: 'cancelled' })).toBe(false)
  })

  it('leaves humans alone', () => {
    // People coordinate by talking. Someone leaving a comment has not
    // necessarily picked the work up, and showing them as holding it would be
    // a claim about them they did not make.
    expect(shouldClaimByWorking(human, { status: 'todo' })).toBe(false)
  })
})

/**
 * A claim names a session, not just a human.
 *
 * `claimed_by` is an actorLabel — `claude-code · cal@example.com` — and every
 * Claude Code session on a machine writes exactly that. Four run here at once.
 * The claim itself was never the broken part: claim_task_atomic refuses a
 * second holder. What was broken is everything that read the label and
 * believed it named a worker, and the cost was not theoretical — two sessions
 * implemented the same fix forty minutes apart because neither could see who
 * held the task.
 */
describe('whose claim this is', () => {
  it('knows another session when both sides can say', () => {
    expect(isAnotherSessionsClaim('session-a', 'session-b')).toBe(true)
  })

  it('is not a foreign claim when the session matches', () => {
    expect(isAnotherSessionsClaim('session-a', 'session-a')).toBe(false)
  })

  it('treats a claim that names no session as releasable', () => {
    // Claimed before the column existed, or by a runtime with no session to
    // give. "Cannot tell" must not become "not yours", or releases that have
    // always worked start failing.
    expect(isAnotherSessionsClaim(null, 'session-b')).toBe(false)
    expect(isAnotherSessionsClaim(undefined, 'session-b')).toBe(false)
  })

  it('treats a caller with no session as unable to object', () => {
    // Codex and OpenClaw may not have one. They keep today's behaviour rather
    // than being locked out of releasing anything.
    expect(isAnotherSessionsClaim('session-a', null)).toBe(false)
  })
})

describe('same-session renewal eligibility', () => {
  const caller = { actorType: 'agent' as const, actorId: 'codex · Cal', sessionId: 'session-a' }
  const held = { claimed_by: caller.actorId, claimed_session: caller.sessionId, status: 'doing' }

  it('requires the same holder and a positively matching session', () => {
    expect(canRenewClaim(caller, held)).toBe(true)
    expect(canRenewClaim({ ...caller, sessionId: 'session-b' }, held)).toBe(false)
    expect(canRenewClaim({ ...caller, sessionId: null }, held)).toBe(false)
    expect(canRenewClaim(caller, { ...held, claimed_session: null })).toBe(false)
    expect(canRenewClaim(caller, { ...held, claimed_by: 'codex · Someone else' })).toBe(false)
    expect(canRenewClaim(caller, { ...held, claimed_by: null })).toBe(false)
  })

  it('never renews for a human even with the matching label and session', () => {
    expect(canRenewClaim({ ...caller, actorType: 'human' }, held)).toBe(false)
  })

  it.each(['done', 'cancelled'])('refuses terminal status %s', (status) => {
    expect(canRenewClaim(caller, { ...held, status })).toBe(false)
  })

  it.each([null, 'todo', 'doing', 'unknown'])('refuses open hand-off status %s', (status) => {
    expect(canRenewClaim(caller, { ...held, handoff_ref: 'EXT-1', handoff_status: status })).toBe(false)
  })

  it.each(['done', 'cancelled'])('allows a settled hand-off with status %s', (status) => {
    expect(canRenewClaim(caller, { ...held, handoff_ref: 'EXT-1', handoff_status: status })).toBe(true)
  })
})
