import React, { useEffect, useMemo, useState } from 'react'
import { listMatches, upsertMatch } from './db'

const STORAGE_KEY = 'cricket-react-current-v1'
const HISTORY_KEY = 'cricket-react-history-v1'
const BALLS_PER_OVER = 6

const rules = {
  ballsPerOver: 6,
  widesAddOneRun: true,
  widesAreRebowled: true,
  noBallAddsAutomaticRun: false,
  noBallIsRebowled: true,
  inningsEndsAtAllOut: true,
  lastManStands: true,
}

function uid() {
  return Math.random().toString(36).slice(2, 10)
}


function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function teamLabel(teamKey) {
  return teamKey === 'team1' ? 'Team 1' : 'Team 2'
}

function parseCsv(text) {
  return (text || '').split(',').map(s => s.trim()).filter(Boolean)
}

function normalize(text) {
  return (text || '').toLowerCase().replace(/[.,!?;:()]/g, ' ').replace(/\s+/g, ' ').trim()
}

function includesAny(text, list) {
  return list.some(v => text.includes(v))
}

function oversFromBalls(balls) {
  return `${Math.floor(balls / BALLS_PER_OVER)}.${balls % BALLS_PER_OVER}`
}

function detectNames(text, names) {
  const t = ` ${normalize(text)} `
  return names.filter((name) => {
    const n = (name || '').trim().toLowerCase()
    if (!n) return false
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(t)
  })
}

function inferRuns(t) {
  if (includesAny(t, ['dot', 'no run', 'no runs'])) return 0
  if (includesAny(t, ['single', '1 run', 'one run', 'a single', 'for one', 'takes one'])) return 1
  if (includesAny(t, ['double', '2 runs', 'two runs', 'for two', 'takes two'])) return 2
  if (includesAny(t, ['3 runs', 'three runs', 'for three', 'takes three', 'three by', 'three'])) return 3
  if (includesAny(t, ['4 runs', 'four runs', 'boundary', 'to the boundary', 'slapped to the boundary', 'fierce shot to the boundary'])) return 4
  if (includesAny(t, ['6 runs', 'six runs', 'six', 'maximum', 'out of the park', 'over the boundary'])) return 6
  const m = t.match(/\b([0-6])\b/)
  return m ? Number(m[1]) : null
}

function detectDismissalType(t) {
  if (includesAny(t, ['run out', 'runout'])) return 'run out'
  if (includesAny(t, ['caught', 'in the air', 'miscued'])) return 'caught'
  if (t.includes('bowled')) return 'bowled'
  if (t.includes('out')) return 'unknown'
  return ''
}

function createInnings(number, battingTeamKey) {
  return {
    number,
    battingTeamKey,
    striker: '',
    nonStriker: '',
    currentBowler: '',
    completed: false,
    balls: [],
    manualOverride: null,
  }
}

function createMatch(setup) {
  const first = setup.firstBattingTeam
  const second = first === 'team1' ? 'team2' : 'team1'
  return {
    id: uid(),
    createdAt: new Date().toISOString(),
    overs: Number(setup.overs) || 5,
    team1Players: parseCsv(setup.team1),
    team2Players: parseCsv(setup.team2),
    sharedPlayer: (setup.sharedPlayer || '').trim(),
    dynamicPlayers: [],
    inningsIndex: 0,
    innings: [createInnings(1, first), createInnings(2, second)],
    completed: false,
  }
}

function getAllPlayers(match) {
  return [...new Set([...(match.team1Players || []), ...(match.team2Players || []), ...(match.sharedPlayer ? [match.sharedPlayer] : []), ...(match.dynamicPlayers || [])])]
}

function activeTeamPlayers(match, innings) {
  const battingPlayers = innings.battingTeamKey === 'team1' ? match.team1Players : match.team2Players
  const bowlingPlayers = innings.battingTeamKey === 'team1' ? match.team2Players : match.team1Players
  return {
    battingPlayers: [...battingPlayers, ...(match.sharedPlayer ? [match.sharedPlayer] : [])],
    bowlingPlayers,
  }
}

function ensurePlayerExists(match, name) {
  if (!name) return
  if (!getAllPlayers(match).includes(name)) match.dynamicPlayers.push(name)
}

function ensureInningsDefaults(match, inningsIndex = match.inningsIndex) {
  const innings = match?.innings?.[inningsIndex]
  if (!match || !innings) return match
  const players = activeTeamPlayers(match, innings)
  const batting = [...new Set([...players.battingPlayers, ...match.dynamicPlayers])].filter(Boolean)
  const bowling = [...new Set([...players.bowlingPlayers, ...match.dynamicPlayers])].filter(Boolean)
  if (!innings.striker && batting[0]) innings.striker = batting[0]
  if (!innings.nonStriker) innings.nonStriker = batting[1] || batting[0] || ''
  if (!innings.currentBowler && bowling[0]) innings.currentBowler = bowling[0]
  return match
}

function parseBallText(raw, ctx) {
  const t = normalize(raw)
  const names = detectNames(t, ctx.allPlayers)
  const active = [ctx.striker, ctx.nonStriker].filter(Boolean)
  const namedActive = names.find(n => active.includes(n))
  let dismissalType = detectDismissalType(t)
  const runs = inferRuns(t)

  const event = {
    id: uid(),
    raw,
    batter: namedActive || (includesAny(t, ['non striker', 'non-striker']) ? ctx.nonStriker : ctx.striker),
    bowler: ctx.currentBowler,
    runsOffBat: runs ?? 0,
    extras: 0,
    extraType: '',
    wicket: false,
    dismissalType: '',
    dismissalPlayer: '',
    legalBall: true,
    nextBatter: '',
    nextBatterEnd: '',
    needsReview: false,
    askDismissedBatter: false,
    askRunsScored: false,
    nextBatterRequired: false,
    note: '',
    reviewRunOutRuns: false,
  }

  if (!t) {
    event.needsReview = true
    event.note = 'Enter a ball description.'
    return event
  }

  if (/\b\d+\s+after\s+\d+\b/.test(t) || /after\s+over\s+\d+/.test(t)) {
    event.needsReview = true
    event.note = 'This looks like over-summary text, not a ball event.'
    return event
  }

  const currentBowlerNormalized = normalize(ctx.currentBowler || '')
  if (currentBowlerNormalized && t.includes(`dot by ${currentBowlerNormalized}`)) {
    event.batter = ctx.striker
    event.runsOffBat = 0
    return event
  }
  if (includesAny(t, ['good ball by', 'beaten', 'play and miss', 'dot again'])) {
    event.batter = ctx.striker
    event.runsOffBat = 0
    return event
  }

  if (t.includes('wide')) {
    event.extraType = 'wide'
    event.extras += rules.widesAddOneRun ? 1 : 0
    event.legalBall = false
    if (runs && runs > 0 && !includesAny(t, ['single', 'one run'])) {
      event.extras += runs
      event.runsOffBat = 0
    }
  }

  if (includesAny(t, ['no ball', 'no-ball', 'noball'])) {
    event.extraType = 'no-ball'
    event.legalBall = false
    if (rules.noBallAddsAutomaticRun) event.extras += 1
  }

  const missedChanceOnly = includesAny(t, ['run out chance missed', 'runout chance missed', 'chance missed', 'dropped the catch', 'drop catch', 'catch dropped', 'missed run out'])
  if (missedChanceOnly) {
    event.wicket = false
    dismissalType = ''
  }

  if (dismissalType) {
    if (event.extraType === 'wide') {
      event.needsReview = true
      event.note = 'Batter cannot be out on a wide.'
      return event
    }
    event.wicket = true
    event.dismissalType = dismissalType
    event.nextBatterRequired = true
    if (dismissalType === 'run out') {
      event.needsReview = true
      event.askDismissedBatter = true
      event.askRunsScored = true
      event.nextBatterRequired = true
      event.reviewRunOutRuns = true
      event.note = 'Select who got out, completed runs, incoming batter, and the incoming batter end.'
      const activeNamesInText = names.filter(n => active.includes(n))
      if (activeNamesInText.length === 1) event.dismissalPlayer = activeNamesInText[0]
      else if (activeNamesInText.length >= 2) {
        event.batter = activeNamesInText[0]
        event.dismissalPlayer = activeNamesInText[1]
      } else if (namedActive) {
        event.dismissalPlayer = namedActive
      }
      if (includesAny(t, ['trying to steal a second', 'tried to steal a second', 'going for 2', 'going for two', 'trying to go for the second', 'trying to go for second', 'goes for a second', 'went for a second', 'gets run out on the second run'])) {
        event.runsOffBat = Math.max(event.runsOffBat, 1)
      }
      if (activeNamesInText.length < 2) event.batter = ctx.striker
      return event
    }
    event.dismissalPlayer = namedActive || ctx.striker
    if (!event.extraType) {
      event.runsOffBat = includesAny(t, ['single', 'double', 'three', 'four', 'six', '1 run', '2 runs', '3 runs', '4 runs', '6 runs', 'for one', 'for two', 'for three', 'to the boundary']) ? event.runsOffBat : 0
    }
  }

  if (t.includes('out') && dismissalType === 'unknown') {
    event.needsReview = true
    event.note = 'Specify wicket type.'
    return event
  }

  if (runs === null && !event.wicket && !event.extraType && !includesAny(t, ['dot', 'no run', 'no runs'])) {
    event.needsReview = true
    event.note = 'Could not infer runs confidently.'
  }

  return event
}

function computeState(match, innings) {
  const { battingPlayers, bowlingPlayers } = activeTeamPlayers(match, innings)
  const batting = Object.fromEntries([...new Set([...battingPlayers, ...match.dynamicPlayers])].map(p => [p, { name: p, runs: 0, balls: 0, status: 'not out' }]))
  const bowling = Object.fromEntries([...new Set([...bowlingPlayers, ...match.dynamicPlayers])].map(p => [p, { name: p, balls: 0, runs: 0, wickets: 0 }]))

  let striker = innings.striker
  let nonStriker = innings.nonStriker
  let currentBowler = innings.currentBowler
  let totalRuns = 0
  let extras = 0
  let wickets = 0
  let legalBalls = 0
  let lastOverCompleted = false

  innings.balls.forEach((ball, index) => {
    ensurePlayerExists(match, ball.batter)
    ensurePlayerExists(match, ball.dismissalPlayer)
    ensurePlayerExists(match, ball.bowler)
    ensurePlayerExists(match, ball.nextBatter)
    if (!batting[ball.batter]) batting[ball.batter] = { name: ball.batter, runs: 0, balls: 0, status: 'not out' }
    if (ball.dismissalPlayer && !batting[ball.dismissalPlayer]) batting[ball.dismissalPlayer] = { name: ball.dismissalPlayer, runs: 0, balls: 0, status: 'not out' }
    if (ball.nextBatter && !batting[ball.nextBatter]) batting[ball.nextBatter] = { name: ball.nextBatter, runs: 0, balls: 0, status: 'not out' }
    if (!bowling[ball.bowler]) bowling[ball.bowler] = { name: ball.bowler, balls: 0, runs: 0, wickets: 0 }
    totalRuns += (ball.runsOffBat || 0) + (ball.extras || 0)
    extras += ball.extras || 0
    batting[ball.batter].runs += ball.runsOffBat || 0
    bowling[ball.bowler].runs += (ball.runsOffBat || 0) + (ball.extras || 0)
    if (ball.legalBall) {
      legalBalls += 1
      batting[ball.batter].balls += 1
      bowling[ball.bowler].balls += 1
    }
    if (ball.wicket) {
      wickets += 1
      if (ball.dismissalPlayer) {
        if (!batting[ball.dismissalPlayer]) batting[ball.dismissalPlayer] = { name: ball.dismissalPlayer, runs: 0, balls: 0, status: 'not out' }
        batting[ball.dismissalPlayer].status = ball.dismissalType || 'out'
      }
      if (!['run out'].includes(ball.dismissalType)) bowling[ball.bowler].wickets += 1
    }

    const runningExtrasForSwap = ball.extraType === 'wide' ? Math.max((ball.extras || 0) - 1, 0) : 0
    const swap = ((ball.runsOffBat || 0) + runningExtrasForSwap) % 2 === 1
    let nextStriker = striker
    let nextNonStriker = nonStriker
    if (swap) {
      nextStriker = nonStriker
      nextNonStriker = striker
    }
    if (ball.wicket) {
      if (ball.nextBatter) {
        const survivor = ball.dismissalPlayer === striker ? nonStriker : striker
        if (ball.nextBatterEnd === 'striker') {
          nextStriker = ball.nextBatter
          nextNonStriker = survivor
        } else {
          nextStriker = survivor
          nextNonStriker = ball.nextBatter
        }
      } else if (rules.lastManStands) {
        const survivor = ball.dismissalPlayer === striker ? nonStriker : striker
        nextStriker = survivor
        nextNonStriker = survivor
      }
    }
    striker = nextStriker
    nonStriker = nextNonStriker
    lastOverCompleted = false
    if (ball.legalBall && legalBalls % BALLS_PER_OVER === 0) {
      ;[striker, nonStriker] = [nonStriker, striker]
      currentBowler = ''
      lastOverCompleted = true
    } else if (ball.bowler) {
      currentBowler = ball.bowler
    }
    if (innings.manualOverride && innings.manualOverride.afterBallCount === index + 1) {
      striker = innings.manualOverride.striker || striker
      nonStriker = innings.manualOverride.nonStriker || nonStriker
      currentBowler = innings.manualOverride.currentBowler || currentBowler
    }
  })

  if (innings.manualOverride && innings.manualOverride.afterBallCount === 0) {
    striker = innings.manualOverride.striker || striker
    nonStriker = innings.manualOverride.nonStriker || nonStriker
    currentBowler = innings.manualOverride.currentBowler || currentBowler
  }
  if (innings.manualOverride && innings.manualOverride.afterBallCount >= innings.balls.length && innings.balls.length > 0) {
    striker = innings.manualOverride.striker || striker
    nonStriker = innings.manualOverride.nonStriker || nonStriker
    currentBowler = innings.manualOverride.currentBowler || currentBowler
  }

  const target = innings.number === 2 ? computeState(match, match.innings[0]).summary.totalRuns + 1 : null
  const availableBatters = [...new Set([...battingPlayers, ...match.dynamicPlayers])]
  const allOut = rules.lastManStands ? false : wickets >= availableBatters.length
  const completed = !!(innings.completed || (rules.inningsEndsAtAllOut && allOut) || legalBalls >= match.overs * BALLS_PER_OVER || (target && totalRuns >= target))
  return {
    batting: Object.values(batting).filter(p => p.runs > 0 || p.balls > 0 || p.status !== 'not out'),
    bowling: Object.values(bowling).filter(p => p.balls > 0 || p.runs > 0 || p.wickets > 0),
    summary: {
      totalRuns,
      extras,
      wickets,
      legalBalls,
      overs: oversFromBalls(legalBalls),
      striker,
      nonStriker,
      currentBowler,
      target,
      completed,
      lastOverCompleted,
    },
  }
}

function legalBallLabel(index, innings) {
  let legal = 0
  for (let i = 0; i <= index; i += 1) {
    const ball = innings.balls[i]
    if (ball.legalBall) {
      legal += 1
      if (i === index) return `${Math.floor((legal - 1) / BALLS_PER_OVER) + 1}.${((legal - 1) % BALLS_PER_OVER) + 1}`
    } else if (i === index) {
      return `${Math.floor(legal / BALLS_PER_OVER) + 1}.X`
    }
  }
  return ''
}

function summarizeBall(ball) {
  if (ball.wicket && ball.dismissalType === 'run out') return `W (RO${ball.runsOffBat ? `+${ball.runsOffBat}` : ''})`
  if (ball.wicket) return `W (${ball.dismissalType || 'out'})`
  if (ball.extraType === 'wide') return `Wd${ball.extras > 1 ? `+${ball.extras - 1}` : ''}`
  if (ball.extraType === 'no-ball') return `Nb${ball.runsOffBat ? `+${ball.runsOffBat}` : ''}`
  return String((ball.runsOffBat || 0) + (ball.extras || 0))
}

function summarizeBallLong(ball) {
  const parts = []
  if (ball.extraType === 'wide') parts.push('Wide')
  else if (ball.extraType === 'no-ball') parts.push('No ball')
  if ((ball.runsOffBat || 0) > 0) parts.push(`${ball.runsOffBat} run${ball.runsOffBat === 1 ? '' : 's'} to ${ball.batter}`)
  if ((ball.runsOffBat || 0) === 0 && !ball.extraType && !ball.wicket) parts.push(`Dot to ${ball.batter}`)
  if (ball.wicket) parts.push(`${ball.dismissalPlayer || ball.batter} ${ball.dismissalType}`)
  return parts.join(' · ') || ball.raw
}


function isValidMatch(match) {
  return Boolean(
    match &&
    Array.isArray(match.innings) &&
    match.innings.length >= 2 &&
    match.innings[0]?.battingTeamKey &&
    match.innings[1]?.battingTeamKey
  )
}

function matchResult(match) {
  if (!isValidMatch(match)) return 'Invalid saved match'
  const first = computeState(clone(match), clone(match.innings[0])).summary
  const second = computeState(clone(match), clone(match.innings[1])).summary
  if (!match.completed && !match.innings[1].completed) return 'Match in progress'
  if (second.totalRuns >= first.totalRuns + 1) {
    const battingCount = match.innings[1].battingTeamKey === 'team1' ? match.team1Players.length : match.team2Players.length
    return `${teamLabel(match.innings[1].battingTeamKey)} won by ${Math.max(1, battingCount - 1 - second.wickets)} wickets`
  }
  if (second.totalRuns < first.totalRuns) return `${teamLabel(match.innings[0].battingTeamKey)} won by ${first.totalRuns - second.totalRuns} runs`
  return 'Match tied'
}

function overGroups(innings) {
  let legal = 0
  const groups = []
  let current = { over: 1, balls: [] }
  innings.balls.forEach((ball) => {
    current.balls.push(ball)
    if (ball.legalBall) legal += 1
    if (ball.legalBall && legal % BALLS_PER_OVER === 0) {
      groups.push({ ...current, totalRuns: current.balls.reduce((a, b) => a + (b.runsOffBat || 0) + (b.extras || 0), 0) })
      current = { over: groups.length + 1, balls: [] }
    }
  })
  if (current.balls.length) groups.push({ ...current, totalRuns: current.balls.reduce((a, b) => a + (b.runsOffBat || 0) + (b.extras || 0), 0) })
  return groups
}

function formatMatchDate(value) {
  if (!value) return "Date unavailable"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Date unavailable"
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date)
}

function normalizeHistoryItems(items) {
  return (items || [])
    .map((item, index) => {
      if (item.match) return item
      return {
        id: item.id,
        gameNumber: item.gameNumber || index + 1,
        savedAt: item.savedAt || new Date().toISOString(),
        match: item,
      }
    })
    .filter(item => isValidMatch(item.match))
}

export default function App() {
  const [setup, setSetup] = useState({ team1: '', team2: '', sharedPlayer: '', overs: 5, firstBattingTeam: 'team1' })
  const [match, setMatch] = useState(null)
  const [history, setHistory] = useState([])
  const [ballText, setBallText] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewEvent, setReviewEvent] = useState(null)
  const [dismissedBatter, setDismissedBatter] = useState('')
  const [reviewRuns, setReviewRuns] = useState('0')
  const [nextBatter, setNextBatter] = useState('')
  const [nextBatterEnd, setNextBatterEnd] = useState('striker')
  const [noBallOpen, setNoBallOpen] = useState(false)
  const [noBallRuns, setNoBallRuns] = useState('0')
  const [noBallBatter, setNoBallBatter] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [override, setOverride] = useState({ striker: '', nonStriker: '', bowler: '' })
  const [bowlerPromptOpen, setBowlerPromptOpen] = useState(false)
  const [nextBowler, setNextBowler] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [editEvent, setEditEvent] = useState(null)

  useEffect(() => {
    const current = localStorage.getItem(STORAGE_KEY)
    if (current) setMatch(JSON.parse(current))

    async function loadRemoteHistory() {
      try {
        const rows = await listMatches()
        const mapped = rows
          .filter(row => isValidMatch(row.match_json))
          .map((row, index) => ({
            id: row.app_match_id || row.id,
            gameNumber: index + 1,
            savedAt: row.updated_at || row.created_at,
            match: row.match_json,
          }))
        setHistory(normalizeHistoryItems(mapped))
      } catch (error) {
        console.error('Failed to load matches from Supabase', error)
        const savedHistory = localStorage.getItem(HISTORY_KEY)
        if (savedHistory) setHistory(normalizeHistoryItems(JSON.parse(savedHistory)))
      }
    }

    loadRemoteHistory()
  }, [])

  useEffect(() => {
    if (match) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(match))
      upsertMatch(match).catch((error) => {
        console.error('Failed to sync match to Supabase', error)
      })
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  }, [match])

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  }, [history])

  const innings = match ? match.innings[match.inningsIndex] : null
  const state = useMemo(() => (match && innings ? computeState(clone(match), clone(innings)) : null), [match, innings])
  const currentPlayers = useMemo(() => (match && innings ? activeTeamPlayers(match, innings) : { battingPlayers: [], bowlingPlayers: [] }), [match, innings])
  const allPlayers = useMemo(() => (match ? getAllPlayers(match) : []), [match])
  const target = match && innings?.number === 2 ? computeState(clone(match), clone(match.innings[0])).summary.totalRuns + 1 : null

  useEffect(() => {
    if (state && innings) {
      setOverride({
        striker: state.summary.striker || innings.striker || '',
        nonStriker: state.summary.nonStriker || innings.nonStriker || '',
        bowler: state.summary.currentBowler || innings.currentBowler || '',
      })
    }
  }, [match?.inningsIndex, innings?.balls?.length])

  function persistFinished(updated) {
    setHistory(prev => {
      const normalized = normalizeHistoryItems(prev)
      const existing = normalized.findIndex(item => item.id === updated.id)
      const payload = {
        id: updated.id,
        gameNumber: existing >= 0 ? normalized[existing].gameNumber : normalized.length + 1,
        savedAt: new Date().toISOString(),
        match: clone(updated),
      }
      if (existing >= 0) normalized[existing] = payload
      else normalized.unshift(payload)
      return normalized.slice(0, 50)
    })

    upsertMatch(updated).catch((error) => {
      console.error('Failed to persist finished match to Supabase', error)
    })
  }

  function openSavedMatch(item) {
    const opened = clone(item.match || item)
    if (!isValidMatch(opened)) return
    ensureInningsDefaults(opened, opened.inningsIndex)
    setMatch(opened)
  }

  function startMatch() {
    const created = createMatch(setup)
    ensureInningsDefaults(created, 0)
    setMatch(created)
  }

  function pushBall(event) {
    const updated = clone(match)
    ensurePlayerExists(updated, event.batter)
    ensurePlayerExists(updated, event.dismissalPlayer)
    ensurePlayerExists(updated, event.nextBatter)
    ensurePlayerExists(updated, event.bowler)
    updated.innings[updated.inningsIndex].balls.push(event)
    const updatedState = computeState(clone(updated), clone(updated.innings[updated.inningsIndex]))
    updated.innings[updated.inningsIndex].completed = updatedState.summary.completed
    if (updated.inningsIndex === 1 && updatedState.summary.completed) {
      updated.completed = true
      persistFinished(updated)
    }
    setMatch(updated)
    setBallText('')
    if (updatedState.summary.lastOverCompleted && !updatedState.summary.completed) {
      const bowlers = activeTeamPlayers(updated, updated.innings[updated.inningsIndex]).bowlingPlayers
      setNextBowler(bowlers[0] || '')
      setBowlerPromptOpen(true)
    }
  }

  function saveBall() {
    const ctx = {
      striker: state?.summary?.striker || innings?.striker,
      nonStriker: state?.summary?.nonStriker || innings?.nonStriker,
      currentBowler: state?.summary?.currentBowler || innings?.currentBowler || override.bowler,
      allPlayers,
    }
    const event = parseBallText(ballText, ctx)
    if (!event.bowler) event.bowler = ctx.currentBowler

    if (event.extraType === 'no-ball' && event.runsOffBat === 0 && !event.wicket && !includesAny(normalize(ballText), ['dot', 'single', 'double', 'three', 'four', 'six', '1 run', '2 runs', '3 runs', '4 runs', '6 runs'])) {
      setNoBallBatter(ctx.striker || '')
      setNoBallRuns('0')
      setReviewEvent(event)
      setNoBallOpen(true)
      return
    }

    if (event.needsReview || event.askDismissedBatter || event.nextBatterRequired) {
      setReviewEvent(event)
      setDismissedBatter(event.dismissalPlayer || state.summary.striker || '')
      setReviewRuns(String(event.runsOffBat || 0))
      setNextBatter('')
      setNextBatterEnd(event.nextBatterEnd || (event.dismissalPlayer === state.summary.striker ? 'striker' : 'non-striker'))
      setReviewOpen(true)
      return
    }

    pushBall(event)
  }

  function confirmReview() {
    const event = { ...reviewEvent }
    if (event.askDismissedBatter) event.dismissalPlayer = dismissedBatter
    if (event.askRunsScored) event.runsOffBat = Number(reviewRuns || 0)
    if (event.nextBatterRequired) {
      event.nextBatter = nextBatter
      event.nextBatterEnd = nextBatterEnd
      if (!event.nextBatter && !rules.lastManStands) return
    }
    if (event.dismissalType === 'run out') event.batter = state.summary.striker
    setReviewOpen(false)
    setReviewEvent(null)
    pushBall(event)
  }

  function confirmNoBall() {
    const runs = Number(noBallRuns || 0)
    const event = { ...reviewEvent, raw: `No ball, ${Number.isNaN(runs) ? 0 : runs} by ${noBallBatter || state.summary.striker}`, batter: noBallBatter || state.summary.striker, runsOffBat: Number.isNaN(runs) ? 0 : runs }
    setNoBallOpen(false)
    setReviewEvent(null)
    pushBall(event)
  }

  function saveNextBowler() {
    if (!nextBowler) return
    const updated = clone(match)
    const inn = updated.innings[updated.inningsIndex]
    inn.currentBowler = nextBowler
    ensurePlayerExists(updated, nextBowler)
    setMatch(updated)
    setBowlerPromptOpen(false)
    setNextBowler('')
  }

  function renamePlayer() {
    const updated = clone(match)
    const from = renameFrom.trim()
    const to = renameTo.trim()
    const remap = (list) => list.map(p => (p === from ? to : p))
    updated.team1Players = remap(updated.team1Players)
    updated.team2Players = remap(updated.team2Players)
    if (updated.sharedPlayer === from) updated.sharedPlayer = to
    updated.dynamicPlayers = remap(updated.dynamicPlayers)
    updated.innings.forEach((inn) => {
      if (inn.striker === from) inn.striker = to
      if (inn.nonStriker === from) inn.nonStriker = to
      if (inn.currentBowler === from) inn.currentBowler = to
      if (inn.manualOverride) {
        inn.manualOverride.striker = inn.manualOverride.striker === from ? to : inn.manualOverride.striker
        inn.manualOverride.nonStriker = inn.manualOverride.nonStriker === from ? to : inn.manualOverride.nonStriker
        inn.manualOverride.currentBowler = inn.manualOverride.currentBowler === from ? to : inn.manualOverride.currentBowler
      }
      inn.balls = inn.balls.map(ball => ({
        ...ball,
        batter: ball.batter === from ? to : ball.batter,
        bowler: ball.bowler === from ? to : ball.bowler,
        dismissalPlayer: ball.dismissalPlayer === from ? to : ball.dismissalPlayer,
        nextBatter: ball.nextBatter === from ? to : ball.nextBatter,
      }))
    })
    setMatch(updated)
    if (updated.completed) persistFinished(updated)
    setRenameOpen(false)
    setRenameFrom('')
    setRenameTo('')
  }

  function overridePlayers() {
    const updated = clone(match)
    updated.innings[updated.inningsIndex].striker = override.striker
    updated.innings[updated.inningsIndex].nonStriker = override.nonStriker
    updated.innings[updated.inningsIndex].currentBowler = override.bowler
    updated.innings[updated.inningsIndex].manualOverride = {
      afterBallCount: updated.innings[updated.inningsIndex].balls.length,
      striker: override.striker,
      nonStriker: override.nonStriker,
      currentBowler: override.bowler,
    }
    ensurePlayerExists(updated, override.striker)
    ensurePlayerExists(updated, override.nonStriker)
    ensurePlayerExists(updated, override.bowler)
    setMatch(updated)
  }

  function openEdit(inningsIndex, ballIndex) {
    const targetInnings = match.innings[inningsIndex]
    const ball = targetInnings?.balls?.[ballIndex]
    if (!ball) return
    setEditTarget({ inningsIndex, ballIndex })
    setEditEvent(clone(ball))
    setEditOpen(true)
  }

  function updateEditField(field, value) {
    setEditEvent(prev => ({ ...prev, [field]: value }))
  }

  function saveEdit() {
    if (!editTarget || !editEvent) return
    const updated = clone(match)
    const targetInnings = updated.innings[editTarget.inningsIndex]
    const cleaned = {
      ...editEvent,
      runsOffBat: Math.max(0, Number(editEvent.runsOffBat || 0)),
      extras: Math.max(0, Number(editEvent.extras || 0)),
      legalBall: !!editEvent.legalBall,
      wicket: !!editEvent.wicket,
      nextBatterRequired: !!editEvent.wicket && !!editEvent.nextBatter,
      askDismissedBatter: false,
      needsReview: false,
    }
    ensurePlayerExists(updated, cleaned.batter)
    ensurePlayerExists(updated, cleaned.bowler)
    ensurePlayerExists(updated, cleaned.dismissalPlayer)
    ensurePlayerExists(updated, cleaned.nextBatter)
    targetInnings.balls[editTarget.ballIndex] = cleaned
    const editedState = computeState(clone(updated), clone(targetInnings))
    targetInnings.completed = editedState.summary.completed
    if (updated.completed) persistFinished(updated)
    setMatch(updated)
    setEditOpen(false)
    setEditTarget(null)
    setEditEvent(null)
    if (editTarget.inningsIndex === updated.inningsIndex && editTarget.ballIndex === targetInnings.balls.length - 1 && editedState.summary.lastOverCompleted && !editedState.summary.completed) {
      const bowlers = activeTeamPlayers(updated, targetInnings).bowlingPlayers
      setNextBowler(bowlers[0] || '')
      setBowlerPromptOpen(true)
    }
  }

  function undo() {
    if (!innings?.balls?.length) return
    const updated = clone(match)
    updated.innings[updated.inningsIndex].balls.pop()
    updated.innings[updated.inningsIndex].completed = false
    updated.completed = false
    setMatch(updated)
  }

  function endInnings() {
    const updated = clone(match)
    updated.innings[updated.inningsIndex].completed = true
    if (updated.inningsIndex === 0) {
      updated.inningsIndex = 1
      ensureInningsDefaults(updated, 1)
    } else {
      updated.completed = true
      persistFinished(updated)
    }
    setMatch(updated)
  }

  function newMatch() {
    setMatch(null)
    setBallText('')
  }

  const overs = innings ? overGroups(innings) : []

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Cricket Match Scorer</h1>
          <p>React + Vite starter with guided scoring and Netlify-ready build.</p>
        </div>
        <div className="actions-row">
          <button className="secondary" onClick={() => setRenameOpen(true)} disabled={!match}>Rename Player</button>
          <button className="secondary" onClick={newMatch}>New Match</button>
        </div>
      </header>

      {!match ? (
        <div className="setup-grid">
          <section className="panel">
            <h2>Match Setup</h2>
            <label>Team 1 players<textarea value={setup.team1} onChange={e => setSetup({ ...setup, team1: e.target.value })} /></label>
            <label>Team 2 players<textarea value={setup.team2} onChange={e => setSetup({ ...setup, team2: e.target.value })} /></label>
            <div className="grid-3">
              <label>Shared player<input value={setup.sharedPlayer} onChange={e => setSetup({ ...setup, sharedPlayer: e.target.value })} /></label>
              <label>Overs<input type="number" min="1" value={setup.overs} onChange={e => setSetup({ ...setup, overs: e.target.value })} /></label>
              <label>Bat first<select value={setup.firstBattingTeam} onChange={e => setSetup({ ...setup, firstBattingTeam: e.target.value })}><option value="team1">Team 1</option><option value="team2">Team 2</option></select></label>
            </div>
            <button onClick={startMatch}>Start Match</button>
          </section>
          <section className="panel">
            <h2>Completed Games</h2>
            <div className="saved-list">
              {history.length === 0 ? <p className="muted">No saved matches yet.</p> : history.map(item => {
                const savedMatch = item.match || item
                const displayDate = formatMatchDate(item.savedAt || savedMatch.savedAt || savedMatch.updated_at || savedMatch.createdAt)
                return (
                <details className="saved-item history-item" key={item.id}>
                  <summary>
                    <span className="saved-summary"><span className="saved-date">{displayDate}</span><strong>Game {item.gameNumber || '—'}</strong><span>{matchResult(savedMatch)}</span></span>
                    <button className="secondary small-button" onClick={(event) => { event.preventDefault(); openSavedMatch(item) }}>Open / Edit</button>
                  </summary>
                  <div className="history-grid">
                    {isValidMatch(savedMatch) && savedMatch.innings.map((inn) => {
                      const savedState = computeState(clone(savedMatch), clone(inn))
                      return (
                        <div className="mini-card" key={inn.number}>
                          <h3>Innings {inn.number} · {teamLabel(inn.battingTeamKey)}</h3>
                          <p className="muted small">Score: {savedState.summary.totalRuns}/{savedState.summary.wickets} in {savedState.summary.overs}</p>
                          <ScoreTable title="Batting" headers={['Player', 'R', 'B', 'Status']} rows={savedState.batting.map(p => [p.name, p.runs, p.balls, p.status])} />
                          <ScoreTable title="Bowling" headers={['Bowler', 'O', 'R', 'W']} rows={savedState.bowling.map(p => [p.name, oversFromBalls(p.balls), p.runs, p.wickets])} />
                          <div className="commentary-block">
                            <div className="muted small">Commentary</div>
                            {inn.balls.length === 0 ? <p className="muted small">No commentary</p> : inn.balls.map((ball, index) => (
                              <div className="commentary-line" key={ball.id}><strong>{legalBallLabel(index, inn)}</strong> · {ball.raw}</div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </details>
              )})}
            </div>
          </section>
        </div>
      ) : (
        <div className="main-grid">
          <section className="panel large">
            <div className="panel-head">
              <h2>Live Match</h2>
              <span className="badge">Innings {innings.number}</span>
            </div>
            <div className="stats-grid">
              <Stat label="Batting" value={teamLabel(innings.battingTeamKey)} />
              <Stat label="Score" value={`${state.summary.totalRuns}/${state.summary.wickets}`} />
              <Stat label="Overs" value={state.summary.overs} />
              <Stat label="Extras" value={String(state.summary.extras)} />
            </div>
            <div className="stats-grid">
              <Stat label="Target" value={target || '—'} />
              <Stat label="Runs Needed" value={target ? Math.max(target - state.summary.totalRuns, 0) : '—'} />
              <Stat label="Balls Left" value={target ? Math.max(match.overs * BALLS_PER_OVER - state.summary.legalBalls, 0) : '—'} />
              <Stat label="Req RR" value={target ? (((Math.max(target - state.summary.totalRuns, 0)) * BALLS_PER_OVER) / Math.max(match.overs * BALLS_PER_OVER - state.summary.legalBalls, 1)).toFixed(2) : '—'} />
            </div>

            <div className="override-box">
              <h3>Manual override</h3>
              <div className="grid-3">
                <label>Striker<select value={override.striker} onChange={e => setOverride({ ...override, striker: e.target.value })}>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
                <label>Non-striker<select value={override.nonStriker} onChange={e => setOverride({ ...override, nonStriker: e.target.value })}>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
                <label>Bowler<select value={override.bowler} onChange={e => setOverride({ ...override, bowler: e.target.value })}>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
              </div>
              <button className="secondary" onClick={overridePlayers}>Override current players</button>
            </div>

            <div className="quick-actions">
              {[
                ['Dot', `Dot by ${state.summary.striker || 'striker'}`],
                ['1', `Single by ${state.summary.striker || 'striker'}`],
                ['2', `Double by ${state.summary.striker || 'striker'}`],
                ['3', `Three by ${state.summary.striker || 'striker'}`],
                ['4', `${state.summary.striker || 'striker'} to the boundary for four runs`],
                ['6', `${state.summary.striker || 'striker'} hits six`],
                ['Wide', 'Wide'],
                ['Bowled', `${state.summary.striker || 'striker'} bowled`],
                ['Caught Behind', `${state.summary.striker || 'striker'} caught behind`],
                ['Caught', `${state.summary.striker || 'striker'} caught`],
                ['Run Out', `${state.summary.striker || 'striker'} run out`],
              ].map(([label, value]) => <button key={label} className="secondary" onClick={() => setBallText(value)}>{label}</button>)}
              <button className="secondary" onClick={() => {
                setReviewEvent({ raw: 'No ball', bowler: state.summary.currentBowler, batter: state.summary.striker, extraType: 'no-ball', extras: 0, wicket: false, dismissalType: '', dismissalPlayer: '', legalBall: false, runsOffBat: 0 })
                setNoBallBatter(state.summary.striker || '')
                setNoBallRuns('0')
                setNoBallOpen(true)
              }}>No Ball</button>
            </div>

            <label>Ball description<textarea value={ballText} onChange={e => setBallText(e.target.value)} placeholder="Type natural commentary here..." /></label>
            <div className="actions-row">
              <button onClick={saveBall}>Save Ball</button>
              <button className="secondary" onClick={undo}>Undo</button>
              <button className="secondary" onClick={endInnings}>End Innings</button>
            </div>

            <h3>Ball Log</h3>
            <div className="ball-log">
              {overs.length === 0 ? <p className="muted">No balls yet.</p> : overs.map((over, overIndex) => (
                <details key={over.over} open={overIndex === overs.length - 1} className="over-card">
                  <summary>Over {over.over} · {over.totalRuns} runs</summary>
                  {over.balls.map((ball) => {
                    const index = innings.balls.findIndex(x => x.id === ball.id)
                    return <div className="ball-item" key={ball.id}>
                      <strong>{legalBallLabel(index, innings)}</strong> · {ball.raw}
                      <div className="muted small">{ball.batter} · {ball.runsOffBat} bat · {ball.extras} extras {ball.wicket ? `· ${ball.dismissalType}` : ''}</div>
                      <button className="secondary small-button" onClick={() => openEdit(match.inningsIndex, index)}>Edit</button>
                    </div>
                  })}
                </details>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Scorecard</h2>
            <div className="score-block">
              <h3>Batting</h3>
              <table><thead><tr><th>Player</th><th>R</th><th>B</th><th>Status</th></tr></thead><tbody>{state.batting.map(p => <tr key={p.name}><td>{p.name}</td><td>{p.runs}</td><td>{p.balls}</td><td>{p.status}</td></tr>)}</tbody></table>
            </div>
            <div className="score-block">
              <h3>Bowling</h3>
              <table><thead><tr><th>Bowler</th><th>O</th><th>R</th><th>W</th></tr></thead><tbody>{state.bowling.map(p => <tr key={p.name}><td>{p.name}</td><td>{oversFromBalls(p.balls)}</td><td>{p.runs}</td><td>{p.wickets}</td></tr>)}</tbody></table>
            </div>
            <div className="score-block">
              <h3>Result</h3>
              <p>{matchResult(match)}</p>
            </div>
            <div className="score-block">
              <h3>Ball-by-ball commentary</h3>
              {match.innings.filter(inn => inn.completed || inn.balls.length > 0).map((inn) => {
                const inningsIndex = inn.number - 1
                const innState = computeState(clone(match), clone(inn))
                return (
                  <details key={inn.number} className="over-card">
                    <summary>Innings {inn.number} ({teamLabel(inn.battingTeamKey)} batting) · {innState.summary.totalRuns}/{innState.summary.wickets}</summary>
                    {inn.balls.length === 0 ? <p className="muted small">No commentary recorded.</p> : inn.balls.map((ball, ballIndex) => (
                      <div className="ball-item" key={ball.id}>
                        <strong>{legalBallLabel(ballIndex, inn)}</strong> · {ball.raw}
                        <div className="muted small">{summarizeBallLong(ball)}</div>
                        <button className="secondary small-button" onClick={() => openEdit(inningsIndex, ballIndex)}>Edit</button>
                      </div>
                    ))}
                  </details>
                )
              })}
            </div>
          </section>
        </div>
      )}

      {reviewOpen && reviewEvent && (
        <div className="dialog-backdrop"><div className={`dialog ${reviewEvent.dismissalType === 'run out' ? 'wide-dialog' : ''}`}>
          <h3>{reviewEvent.dismissalType === 'run out' ? 'Run out review' : 'Review wicket'}</h3>
          <p className="muted">{reviewEvent.note || 'Confirm wicket details.'}</p>
          {reviewEvent.dismissalType === 'run out' && (
            <div className="runout-context">
              <div><span className="muted small">Striker</span><strong>{state.summary.striker || '—'}</strong></div>
              <div><span className="muted small">Non-striker</span><strong>{state.summary.nonStriker || '—'}</strong></div>
              <div><span className="muted small">Parsed batter</span><strong>{reviewEvent.batter || '—'}</strong></div>
            </div>
          )}
          <div className={reviewEvent.dismissalType === 'run out' ? 'review-grid' : ''}>
            {reviewEvent.askDismissedBatter && <label><span className="step-label">1. Who got out?</span><select value={dismissedBatter} onChange={e => setDismissedBatter(e.target.value)}><option value="">Select dismissed batter</option>{[state.summary.striker, state.summary.nonStriker].filter(Boolean).map(p => <option key={p} value={p}>{p}</option>)}</select></label>}
            {reviewEvent.askRunsScored && <label><span className="step-label">2. Completed runs</span><input type="number" min="0" max="6" value={reviewRuns} onChange={e => setReviewRuns(e.target.value)} /></label>}
            {reviewEvent.nextBatterRequired ? (<>
              <label><span className="step-label">3. Next batter</span><select value={nextBatter} onChange={e => setNextBatter(e.target.value)}><option value="">None / last man</option>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
              <label><span className="step-label">4. Incoming batter end</span><select value={nextBatterEnd} onChange={e => setNextBatterEnd(e.target.value)}><option value="striker">Striker</option><option value="non-striker">Non-striker</option></select></label>
            </>) : <p className="muted">Last man standing applies.</p>}
          </div>
          {reviewEvent.dismissalType === 'run out' && <p className="muted small">For run outs, do not assume the striker was out. Confirm the dismissed batter, completed runs, incoming player, and end before saving.</p>}
          <div className="actions-row"><button className="secondary" onClick={() => setReviewOpen(false)}>Cancel</button><button onClick={confirmReview}>Confirm</button></div>
        </div></div>
      )}

      {noBallOpen && (
        <div className="dialog-backdrop"><div className="dialog">
          <h3>No-ball prompt</h3>
          <p className="muted">Enter the batter and the runs off the bat. The no-ball itself adds 0 automatic runs in your rules.</p>
          <label>Batter<select value={noBallBatter} onChange={e => setNoBallBatter(e.target.value)}>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <label>Runs off bat<input type="number" min="0" max="6" value={noBallRuns} onChange={e => setNoBallRuns(e.target.value)} /></label>
          <div className="actions-row"><button className="secondary" onClick={() => setNoBallOpen(false)}>Cancel</button><button onClick={confirmNoBall}>Save No-Ball</button></div>
        </div></div>
      )}

      {bowlerPromptOpen && match && (
        <div className="dialog-backdrop"><div className="dialog">
          <h3>Over complete</h3>
          <p className="muted">Please select the next bowler.</p>
          <label>Next bowler<select value={nextBowler} onChange={e => setNextBowler(e.target.value)}>
            <option value="">Select bowler</option>
            {[...new Set([...activeTeamPlayers(match, match.innings[match.inningsIndex]).bowlingPlayers, ...match.dynamicPlayers])].filter(Boolean).map(p => <option key={p} value={p}>{p}</option>)}
          </select></label>
          <div className="actions-row"><button onClick={saveNextBowler}>Set Bowler</button></div>
        </div></div>
      )}

      {editOpen && editEvent && (
        <div className="dialog-backdrop"><div className="dialog wide-dialog">
          <h3>Edit ball</h3>
          <p className="muted">Correct the parsed result, then save. The innings is recalculated from the ball list.</p>
          <label>Original text<textarea value={editEvent.raw || ''} onChange={e => updateEditField('raw', e.target.value)} /></label>
          <div className="grid-3">
            <label>Batter<select value={editEvent.batter || ''} onChange={e => updateEditField('batter', e.target.value)}><option value="">Select</option>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
            <label>Bowler<select value={editEvent.bowler || ''} onChange={e => updateEditField('bowler', e.target.value)}><option value="">Select</option>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
            <label>Runs off bat<input type="number" min="0" max="6" value={editEvent.runsOffBat ?? 0} onChange={e => updateEditField('runsOffBat', e.target.value)} /></label>
          </div>
          <div className="grid-3">
            <label>Extras<input type="number" min="0" max="12" value={editEvent.extras ?? 0} onChange={e => updateEditField('extras', e.target.value)} /></label>
            <label>Extra type<select value={editEvent.extraType || ''} onChange={e => updateEditField('extraType', e.target.value)}><option value="">None</option><option value="wide">Wide</option><option value="no-ball">No ball</option></select></label>
            <label>Legal ball?<select value={String(!!editEvent.legalBall)} onChange={e => updateEditField('legalBall', e.target.value === 'true')}><option value="true">Yes</option><option value="false">No</option></select></label>
          </div>
          <div className="grid-3">
            <label>Wicket?<select value={String(!!editEvent.wicket)} onChange={e => updateEditField('wicket', e.target.value === 'true')}><option value="false">No</option><option value="true">Yes</option></select></label>
            <label>Dismissal type<select value={editEvent.dismissalType || ''} onChange={e => updateEditField('dismissalType', e.target.value)}><option value="">None</option><option value="bowled">Bowled</option><option value="caught">Caught</option><option value="run out">Run out</option><option value="unknown">Unknown</option></select></label>
            <label>Dismissed batter<select value={editEvent.dismissalPlayer || ''} onChange={e => updateEditField('dismissalPlayer', e.target.value)}><option value="">Select</option>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          </div>
          <label>Next batter<select value={editEvent.nextBatter || ''} onChange={e => updateEditField('nextBatter', e.target.value)}><option value="">None / last man</option>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <label>Incoming batter end<select value={editEvent.nextBatterEnd || ''} onChange={e => updateEditField('nextBatterEnd', e.target.value)}><option value="">None / last man</option><option value="striker">Striker</option><option value="non-striker">Non-striker</option></select></label>
          <div className="actions-row"><button className="secondary" onClick={() => setEditOpen(false)}>Cancel</button><button onClick={saveEdit}>Save edit</button></div>
        </div></div>
      )}

      {renameOpen && (
        <div className="dialog-backdrop"><div className="dialog">
          <h3>Rename player</h3>
          <label>Current name<select value={renameFrom} onChange={e => setRenameFrom(e.target.value)}><option value="">Select</option>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <label>New name<input value={renameTo} onChange={e => setRenameTo(e.target.value)} /></label>
          <div className="actions-row"><button className="secondary" onClick={() => setRenameOpen(false)}>Cancel</button><button onClick={renamePlayer}>Rename</button></div>
        </div></div>
      )}
    </div>
  )
}

function Stat({ label, value }) {
  return <div className="stat"><div className="stat-label">{label}</div><div className="stat-value">{value}</div></div>
}

function ScoreTable({ title, headers, rows }) {
  return (
    <div className="mini-table">
      <div className="muted small">{title}</div>
      <table>
        <thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={headers.length} className="muted">No entries</td></tr> : rows.map((row, index) => (
            <tr key={`${title}-${index}`}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
