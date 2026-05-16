import React, { useEffect, useMemo, useState } from 'react'
import { toPng } from 'html-to-image'
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

function safeDivide(numerator, denominator, fallback = 0) {
  return denominator ? numerator / denominator : fallback
}

function formatRate(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

function createPlayerBatting(name) {
  return {
    name,
    innings: 0,
    runs: 0,
    balls: 0,
    dismissals: 0,
    notOuts: 0,
    fours: 0,
    sixes: 0,
    singles: 0,
    doubles: 0,
  }
}

function createPlayerBowling(name) {
  return {
    name,
    balls: 0,
    runs: 0,
    wickets: 0,
    dots: 0,
    caught: 0,
    bowled: 0,
  }
}

function createTeamAnalytics(name) {
  return {
    name,
    matches: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    runsFor: 0,
    runsAgainst: 0,
    wicketsLost: 0,
    wicketsTaken: 0,
    extras: 0,
    boundaries: 0,
  }
}

function bump(map, key, factory) {
  if (!key) return null
  if (!map.has(key)) map.set(key, factory(key))
  return map.get(key)
}

function summarizeInningsAnalytics(match, innings) {
  const state = computeState(clone(match), clone(innings))
  let fours = 0
  let sixes = 0
  let singles = 0
  let doubles = 0
  let dots = 0
  let wides = 0
  let noBalls = 0
  const wicketTypes = { bowled: 0, caught: 0, 'run out': 0, unknown: 0 }

  innings.balls.forEach((ball) => {
    const batRuns = ball.runsOffBat || 0
    if (batRuns === 4) fours += 1
    if (batRuns === 6) sixes += 1
    if (batRuns === 1) singles += 1
    if (batRuns === 2) doubles += 1
    if (ball.legalBall && batRuns === 0 && (ball.extras || 0) === 0) dots += 1
    if (ball.extraType === 'wide') wides += 1
    if (ball.extraType === 'no-ball') noBalls += 1
    if (ball.wicket) {
      const type = ball.dismissalType || 'unknown'
      wicketTypes[type] = (wicketTypes[type] || 0) + 1
    }
  })

  const bowlingTeamKey = innings.battingTeamKey === 'team1' ? 'team2' : 'team1'
  return {
    innings,
    state,
    battingTeamKey: innings.battingTeamKey,
    battingTeam: teamLabel(innings.battingTeamKey),
    bowlingTeamKey,
    bowlingTeam: teamLabel(bowlingTeamKey),
    fours,
    sixes,
    singles,
    doubles,
    dots,
    wides,
    noBalls,
    wicketTypes,
    overs: overGroups(innings),
  }
}

function analyzeMatches(historyItems, filters = {}) {
  const selectedTeam = filters.team || 'all'
  const selectedMatchId = filters.matchId || 'all'
  const selectedPlayer = (filters.player || '').trim().toLowerCase()
  const validItems = normalizeHistoryItems(historyItems)
    .filter(item => item.match.completed || item.match.innings?.[1]?.completed)
    .filter(item => selectedMatchId === 'all' || item.id === selectedMatchId)

  const batting = new Map()
  const bowling = new Map()
  const teams = new Map()
  const wicketTypes = { bowled: 0, caught: 0, 'run out': 0, unknown: 0 }
  const matchBreakdowns = []
  const totals = {
    matches: validItems.length,
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    extras: 0,
    fours: 0,
    sixes: 0,
    singles: 0,
    doubles: 0,
    dots: 0,
    catches: 0,
    wides: 0,
    noBalls: 0,
  }

  validItems.forEach((item) => {
    const match = item.match
    const inningsBreakdowns = match.innings.map(inn => summarizeInningsAnalytics(match, inn))
    const first = inningsBreakdowns[0]?.state.summary
    const second = inningsBreakdowns[1]?.state.summary
    const teamKeys = ['team1', 'team2']
    const teamScores = {
      [match.innings[0].battingTeamKey]: first,
      [match.innings[1].battingTeamKey]: second,
    }

    teamKeys.forEach((teamKey) => {
      const team = bump(teams, teamLabel(teamKey), createTeamAnalytics)
      team.matches += 1
      const own = teamScores[teamKey]
      const other = teamScores[teamKey === 'team1' ? 'team2' : 'team1']
      team.runsFor += own?.totalRuns || 0
      team.runsAgainst += other?.totalRuns || 0
      team.wicketsLost += own?.wickets || 0
      team.wicketsTaken += other?.wickets || 0
    })

    if (first && second) {
      const firstTeam = teamLabel(match.innings[0].battingTeamKey)
      const secondTeam = teamLabel(match.innings[1].battingTeamKey)
      if (second.totalRuns >= first.totalRuns + 1) {
        bump(teams, secondTeam, createTeamAnalytics).wins += 1
        bump(teams, firstTeam, createTeamAnalytics).losses += 1
      } else if (second.totalRuns < first.totalRuns) {
        bump(teams, firstTeam, createTeamAnalytics).wins += 1
        bump(teams, secondTeam, createTeamAnalytics).losses += 1
      } else {
        bump(teams, firstTeam, createTeamAnalytics).ties += 1
        bump(teams, secondTeam, createTeamAnalytics).ties += 1
      }
    }

    inningsBreakdowns.forEach((breakdown) => {
      const includeBattingTeam = selectedTeam === 'all' || breakdown.battingTeamKey === selectedTeam
      const includeBowlingTeam = selectedTeam === 'all' || breakdown.bowlingTeamKey === selectedTeam
      const summary = breakdown.state.summary

      if (includeBattingTeam) {
        totals.runs += summary.totalRuns
        totals.wickets += summary.wickets
        totals.legalBalls += summary.legalBalls
        totals.extras += summary.extras
        totals.fours += breakdown.fours
        totals.sixes += breakdown.sixes
        totals.singles += breakdown.singles
        totals.doubles += breakdown.doubles
        totals.dots += breakdown.dots
        totals.wides += breakdown.wides
        totals.noBalls += breakdown.noBalls
        Object.entries(breakdown.wicketTypes).forEach(([type, count]) => {
          wicketTypes[type] = (wicketTypes[type] || 0) + count
        })
        const team = bump(teams, breakdown.battingTeam, createTeamAnalytics)
        team.extras += summary.extras
        team.boundaries += breakdown.fours + breakdown.sixes

        breakdown.state.batting.forEach((player) => {
          const row = bump(batting, player.name, createPlayerBatting)
          row.innings += 1
          row.runs += player.runs
          row.balls += player.balls
          if (player.status === 'not out') row.notOuts += 1
          else row.dismissals += 1
        })

        breakdown.innings.balls.forEach((ball) => {
          const row = bump(batting, ball.batter, createPlayerBatting)
          if (!row) return
          if ((ball.runsOffBat || 0) === 4) row.fours += 1
          if ((ball.runsOffBat || 0) === 6) row.sixes += 1
          if ((ball.runsOffBat || 0) === 1) row.singles += 1
          if ((ball.runsOffBat || 0) === 2) row.doubles += 1
          if (ball.wicket && ball.dismissalType === 'caught') totals.catches += 1
        })
      }

      if (includeBowlingTeam) {
        breakdown.state.bowling.forEach((player) => {
          const row = bump(bowling, player.name, createPlayerBowling)
          row.balls += player.balls
          row.runs += player.runs
          row.wickets += player.wickets
        })
        breakdown.innings.balls.forEach((ball) => {
          const row = bump(bowling, ball.bowler, createPlayerBowling)
          if (!row) return
          if (ball.legalBall && (ball.runsOffBat || 0) === 0 && (ball.extras || 0) === 0) row.dots += 1
          if (ball.wicket && ball.dismissalType === 'caught') row.caught += 1
          if (ball.wicket && ball.dismissalType === 'bowled') row.bowled += 1
        })
      }
    })

    matchBreakdowns.push({
      id: item.id,
      gameNumber: item.gameNumber,
      savedAt: item.savedAt || match.createdAt,
      result: matchResult(match),
      innings: inningsBreakdowns,
    })
  })

  const playerMatchesFilter = row => !selectedPlayer || row.name.toLowerCase().includes(selectedPlayer)
  const battingRows = [...batting.values()].filter(playerMatchesFilter)
  const bowlingRows = [...bowling.values()].filter(playerMatchesFilter)
  const teamRows = [...teams.values()].filter(row => selectedTeam === 'all' || row.name === teamLabel(selectedTeam))

  return {
    totals,
    wicketTypes,
    matches: validItems,
    teamRows,
    battingRows,
    bowlingRows,
    matchBreakdowns,
  }
}

function matchHighlights(match) {
  if (!isValidMatch(match)) return null
  const innings = match.innings.map(inn => summarizeInningsAnalytics(match, inn))
  const battingRows = innings.flatMap(inn => inn.state.batting.map(player => ({ ...player, team: inn.battingTeam })))
  const bowlingRows = innings.flatMap(inn => inn.state.bowling.map(player => ({ ...player, team: inn.bowlingTeam })))
  const topScorer = battingRows.sort((a, b) => b.runs - a.runs || b.balls - a.balls)[0] || null
  const bestBowler = bowlingRows.sort((a, b) => b.wickets - a.wickets || a.runs - b.runs || b.balls - a.balls)[0] || null
  const totals = innings.reduce((acc, inn) => {
    acc.runs += inn.state.summary.totalRuns
    acc.extras += inn.state.summary.extras
    acc.fours += inn.fours
    acc.sixes += inn.sixes
    acc.dots += inn.dots
    acc.legalBalls += inn.state.summary.legalBalls
    Object.entries(inn.wicketTypes).forEach(([type, count]) => {
      acc.wicketTypes[type] = (acc.wicketTypes[type] || 0) + count
    })
    return acc
  }, { runs: 0, extras: 0, fours: 0, sixes: 0, dots: 0, legalBalls: 0, wicketTypes: { bowled: 0, caught: 0, 'run out': 0, unknown: 0 } })
  return { result: matchResult(match), innings, topScorer, bestBowler, totals }
}

function formatScoreLine(highlight) {
  return highlight.innings.map(inn => inn.battingTeam + ': ' + inn.state.summary.totalRuns + '/' + inn.state.summary.wickets + ' in ' + inn.state.summary.overs).join(' | ')
}

function buildMatchSummaryText(match, label = 'Cricket Match') {
  const highlight = matchHighlights(match)
  if (!highlight) return label + '\nNo valid match data.'
  const wicketText = Object.entries(highlight.totals.wicketTypes).filter(([, count]) => count > 0).map(([type, count]) => type + ': ' + count).join(', ') || 'None'
  const lines = [
    label,
    highlight.result,
    formatScoreLine(highlight),
    'Top scorer: ' + (highlight.topScorer ? highlight.topScorer.name + ' ' + highlight.topScorer.runs + ' (' + highlight.topScorer.balls + ')' : 'None'),
    'Best bowler: ' + (highlight.bestBowler ? highlight.bestBowler.name + ' ' + oversFromBalls(highlight.bestBowler.balls) + '-' + highlight.bestBowler.runs + '-' + highlight.bestBowler.wickets : 'None'),
    'Extras: ' + highlight.totals.extras,
    'Boundaries: ' + highlight.totals.fours + ' fours, ' + highlight.totals.sixes + ' sixes',
    'Wickets: ' + wicketText,
  ]
  return lines.join('\n')
}

function playerDirectory(match) {
  if (!match) return []
  const rows = []
  const addRows = (players, team, source) => players.forEach(name => rows.push({ name, team, source }))
  addRows(match.team1Players || [], 'Team 1', 'Roster')
  addRows(match.team2Players || [], 'Team 2', 'Roster')
  if (match.sharedPlayer) rows.push({ name: match.sharedPlayer, team: 'Both', source: 'Shared' })
  addRows(match.dynamicPlayers || [], 'Dynamic', 'Mid-game')
  return rows.filter((row, index, all) => row.name && all.findIndex(item => item.name === row.name && item.team === row.team) === index)
}

function removePlayerFromRosters(match, name) {
  match.team1Players = (match.team1Players || []).filter(player => player !== name)
  match.team2Players = (match.team2Players || []).filter(player => player !== name)
  match.dynamicPlayers = (match.dynamicPlayers || []).filter(player => player !== name)
  if (match.sharedPlayer === name) match.sharedPlayer = ''
}

function addPlayerToRoster(match, name, target) {
  match.team1Players = match.team1Players || []
  match.team2Players = match.team2Players || []
  match.dynamicPlayers = match.dynamicPlayers || []
  const cleanName = (name || '').trim()
  if (!cleanName) return false
  if (target === 'shared') {
    if (match.sharedPlayer && match.sharedPlayer !== cleanName) {
      if (!match.dynamicPlayers.includes(match.sharedPlayer)) match.dynamicPlayers.push(match.sharedPlayer)
    }
    match.sharedPlayer = cleanName
    match.team1Players = (match.team1Players || []).filter(player => player !== cleanName)
    match.team2Players = (match.team2Players || []).filter(player => player !== cleanName)
    match.dynamicPlayers = (match.dynamicPlayers || []).filter(player => player !== cleanName)
    return true
  }
  const key = target === 'team2' ? 'team2Players' : 'team1Players'
  const otherKey = key === 'team1Players' ? 'team2Players' : 'team1Players'
  if (!(match[key] || []).includes(cleanName)) match[key] = [...(match[key] || []), cleanName]
  match[otherKey] = (match[otherKey] || []).filter(player => player !== cleanName)
  if (match.sharedPlayer === cleanName) match.sharedPlayer = ''
  match.dynamicPlayers = (match.dynamicPlayers || []).filter(player => player !== cleanName)
  return true
}


export default function App() {
  const [setup, setSetup] = useState({ team1: '', team2: '', sharedPlayer: '', overs: 5, firstBattingTeam: 'team1' })
  const [match, setMatch] = useState(null)
  const [activeView, setActiveView] = useState('score')
  const [history, setHistory] = useState([])
  const [syncStatus, setSyncStatus] = useState('local')
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
  const [playerDialogOpen, setPlayerDialogOpen] = useState(false)
  const [playerDialogMode, setPlayerDialogMode] = useState('add')
  const [playerName, setPlayerName] = useState('')
  const [playerTargetTeam, setPlayerTargetTeam] = useState('team1')
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [overrideMessage, setOverrideMessage] = useState('')

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
      setSyncStatus('syncing')
      upsertMatch(match)
        .then(() => setSyncStatus('synced'))
        .catch((error) => {
          console.error('Failed to sync match to Supabase', error)
          setSyncStatus('failed')
        })
    } else {
      localStorage.removeItem(STORAGE_KEY)
      setSyncStatus('local')
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

    setSyncStatus('syncing')
    upsertMatch(updated)
      .then(() => setSyncStatus('synced'))
      .catch((error) => {
        console.error('Failed to persist finished match to Supabase', error)
        setSyncStatus('failed')
      })
  }

  function openSavedMatch(item) {
    const opened = clone(item.match || item)
    if (!isValidMatch(opened)) return
    ensureInningsDefaults(opened, opened.inningsIndex)
    setMatch(opened)
    setActiveView('score')
  }

  function startMatch() {
    const created = createMatch(setup)
    ensureInningsDefaults(created, 0)
    setMatch(created)
    setActiveView('score')
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

  function startRename(name = '') {
    setRenameFrom(name)
    setRenameTo('')
    setRenameOpen(true)
  }

  function openAddPlayer() {
    setPlayerDialogMode('add')
    setPlayerName('')
    setPlayerTargetTeam('team1')
    setPlayerDialogOpen(true)
  }

  function openMovePlayer(name) {
    setPlayerDialogMode('move')
    setPlayerName(name || '')
    setPlayerTargetTeam('team1')
    setPlayerDialogOpen(true)
  }

  function savePlayerDialog() {
    const cleanName = playerName.trim()
    if (!cleanName) return
    const updated = clone(match)
    if (playerDialogMode === 'move') removePlayerFromRosters(updated, cleanName)
    addPlayerToRoster(updated, cleanName, playerTargetTeam)
    ensureInningsDefaults(updated, updated.inningsIndex)
    setMatch(updated)
    if (updated.completed) persistFinished(updated)
    setPlayerDialogOpen(false)
    setPlayerName('')
    setPlayerTargetTeam('team1')
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
    if (!match || !innings || !state) return
    const updated = clone(match)
    const inn = updated.innings[updated.inningsIndex]
    const striker = override.striker || state.summary.striker || inn.striker
    const nonStriker = override.nonStriker || state.summary.nonStriker || inn.nonStriker || striker
    const bowler = override.bowler || state.summary.currentBowler || inn.currentBowler
    if (!striker || !nonStriker || !bowler) {
      setOverrideMessage('Select striker, non-striker, and bowler before applying.')
      return
    }
    ensurePlayerExists(updated, striker)
    ensurePlayerExists(updated, nonStriker)
    ensurePlayerExists(updated, bowler)
    inn.striker = striker
    inn.nonStriker = nonStriker
    inn.currentBowler = bowler
    inn.manualOverride = {
      afterBallCount: inn.balls.length,
      striker,
      nonStriker,
      currentBowler: bowler,
    }
    const recalculated = computeState(clone(updated), clone(inn))
    setOverride({ striker: recalculated.summary.striker, nonStriker: recalculated.summary.nonStriker, bowler: recalculated.summary.currentBowler })
    setOverrideMessage('Current players updated.')
    setAdjustOpen(false)
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
    setActiveView('score')
  }

  const overs = innings ? overGroups(innings) : []

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Cricket Match Scorer</h1>
          <p>Fast scoring, saved games, and cricket analytics in one local-first app.</p>
        </div>
        <div className="actions-row">
          <button className="secondary" onClick={() => startRename()} disabled={!match}>Rename Player</button>
          <SyncBadge status={syncStatus} />
          <button className="secondary" onClick={newMatch}>New Match</button>
        </div>
      </header>

      <nav className="view-tabs" aria-label="Primary views">
        {[
          ['score', 'Score'],
          ['games', 'Games'],
          ['analytics', 'Analytics'],
        ].map(([id, label]) => (
          <button key={id} className={activeView === id ? 'tab-button active' : 'tab-button'} onClick={() => setActiveView(id)}>{label}</button>
        ))}
      </nav>

      {activeView === 'score' && (!match ? (
        <main className="setup-view">
          <section className="panel setup-panel">
            <div className="panel-kicker">New match</div>
            <h2>Match Setup</h2>
            <p className="muted">Enter players, choose the first batting side, and start scoring.</p>
            <label>Team 1 players<textarea value={setup.team1} onChange={e => setSetup({ ...setup, team1: e.target.value })} placeholder="Jay, Sam, Nitish" /></label>
            <label>Team 2 players<textarea value={setup.team2} onChange={e => setSetup({ ...setup, team2: e.target.value })} placeholder="Shubhan, Rahul, Aman" /></label>
            <div className="grid-3 setup-controls">
              <label>Shared player<input value={setup.sharedPlayer} onChange={e => setSetup({ ...setup, sharedPlayer: e.target.value })} /></label>
              <label>Overs<input type="number" min="1" value={setup.overs} onChange={e => setSetup({ ...setup, overs: e.target.value })} /></label>
              <label>Bat first<select value={setup.firstBattingTeam} onChange={e => setSetup({ ...setup, firstBattingTeam: e.target.value })}><option value="team1">Team 1</option><option value="team2">Team 2</option></select></label>
            </div>
            <button className="primary-action" onClick={startMatch}>Start Match</button>
          </section>
          <section className="panel glance-panel">
            <div className="panel-kicker">At a glance</div>
            <h2>Ready when you are</h2>
            <div className="glance-list">
              <div><strong>{history.length}</strong><span>saved games</span></div>
              <div><strong>{normalizeHistoryItems(history).filter(item => item.match.completed || item.match.innings?.[1]?.completed).length}</strong><span>completed</span></div>
              <div><strong>{setup.overs || 0}</strong><span>overs planned</span></div>
            </div>
            <button className="secondary" onClick={() => setActiveView('games')}>Browse Games</button>
          </section>
        </main>
      ) : (
        <main className="score-layout">
          <section className="score-main">
            <div className="score-hero">
              <div>
                <div className="panel-kicker">{teamLabel(innings.battingTeamKey)} batting · Innings {innings.number}</div>
                <div className="live-score">{state.summary.totalRuns}/{state.summary.wickets}</div>
                <div className="muted">Overs {state.summary.overs} · Extras {state.summary.extras}</div>
              </div>
              <div className="score-equation">
                <Stat label="Target" value={target || '—'} />
                <Stat label="Need" value={target ? Math.max(target - state.summary.totalRuns, 0) : '—'} />
                <Stat label="Balls" value={target ? Math.max(match.overs * BALLS_PER_OVER - state.summary.legalBalls, 0) : '—'} />
                <Stat label="Req RR" value={target ? (((Math.max(target - state.summary.totalRuns, 0)) * BALLS_PER_OVER) / Math.max(match.overs * BALLS_PER_OVER - state.summary.legalBalls, 1)).toFixed(2) : '—'} />
              </div>
            </div>

            <div className="player-strip">
              <PlayerChip label="Striker" value={state.summary.striker || innings.striker || '—'} active />
              <PlayerChip label="Non-striker" value={state.summary.nonStriker || innings.nonStriker || '—'} />
              <PlayerChip label="Bowler" value={state.summary.currentBowler || innings.currentBowler || '—'} />
            </div>

            <section className="scoring-card">
              <div className="panel-head compact-head"><h2>Score Ball</h2><span className="badge">Quick entry</span></div>
              <QuickGroup title="Runs" items={[
                ['Dot', 'Dot by ' + (state.summary.striker || 'striker')],
                ['1', 'Single by ' + (state.summary.striker || 'striker')],
                ['2', 'Double by ' + (state.summary.striker || 'striker')],
                ['3', 'Three by ' + (state.summary.striker || 'striker')],
                ['4', (state.summary.striker || 'striker') + ' to the boundary for four runs'],
                ['6', (state.summary.striker || 'striker') + ' hits six'],
              ]} onPick={setBallText} />
              <QuickGroup title="Extras" items={[
                ['Wide', 'Wide'],
              ]} onPick={setBallText} extraAction={<button className="secondary quick-button" onClick={() => {
                setReviewEvent({ raw: 'No ball', bowler: state.summary.currentBowler, batter: state.summary.striker, extraType: 'no-ball', extras: 0, wicket: false, dismissalType: '', dismissalPlayer: '', legalBall: false, runsOffBat: 0 })
                setNoBallBatter(state.summary.striker || '')
                setNoBallRuns('0')
                setNoBallOpen(true)
              }}>No Ball</button>} />
              <QuickGroup title="Wickets" items={[
                ['Bowled', (state.summary.striker || 'striker') + ' bowled'],
                ['Caught Behind', (state.summary.striker || 'striker') + ' caught behind'],
                ['Caught', (state.summary.striker || 'striker') + ' caught'],
                ['Run Out', (state.summary.striker || 'striker') + ' run out'],
              ]} onPick={setBallText} />

              <label className="ball-entry-label">Ball description<textarea value={ballText} onChange={e => setBallText(e.target.value)} placeholder="Type natural commentary here..." /></label>
              <div className="actions-row score-actions">
                <button className="primary-action" onClick={saveBall}>Save Ball</button>
                <button className="secondary" onClick={undo}>Undo</button>
                <button className="secondary" onClick={endInnings}>End Innings</button>
              </div>
            </section>

            <details className="adjust-panel" open={adjustOpen} onToggle={event => setAdjustOpen(event.currentTarget.open)}>
              <summary>Adjust current players</summary>
              <div className="grid-3 adjust-grid">
                <label>Striker<select value={override.striker} onChange={e => setOverride({ ...override, striker: e.target.value })}>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
                <label>Non-striker<select value={override.nonStriker} onChange={e => setOverride({ ...override, nonStriker: e.target.value })}>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
                <label>Bowler<select value={override.bowler} onChange={e => setOverride({ ...override, bowler: e.target.value })}>{allPlayers.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
              </div>
              <button className="secondary" onClick={overridePlayers}>Override current players</button>
              {overrideMessage && <p className="muted small override-message">{overrideMessage}</p>}
            </details>

            <section className="panel log-panel">
              <div className="panel-head compact-head"><h2>Ball Log</h2><span className="badge">{innings.balls.length} entries</span></div>
              <div className="ball-log">
                {overs.length === 0 ? <p className="muted">No balls yet.</p> : overs.map((over, overIndex) => (
                  <details key={over.over} open={overIndex === overs.length - 1} className="over-card">
                    <summary>Over {over.over} · {over.totalRuns} runs</summary>
                    {over.balls.map((ball) => {
                      const index = innings.balls.findIndex(x => x.id === ball.id)
                      return <div className="ball-item" key={ball.id}>
                        <strong>{legalBallLabel(index, innings)}</strong> · {ball.raw}
                        <div className="muted small">{ball.batter} · {ball.runsOffBat} bat · {ball.extras} extras {ball.wicket ? '· ' + ball.dismissalType : ''}</div>
                        <button className="secondary small-button" onClick={() => openEdit(match.inningsIndex, index)}>Edit</button>
                      </div>
                    })}
                  </details>
                ))}
              </div>
            </section>
          </section>

          <aside className="score-side">
            {match.completed && <MatchSummaryCard match={match} title="Completed Match" />}
            <section className="panel scorecard-panel">
              <div className="panel-head compact-head"><h2>Scorecard</h2><span className="badge">Live</span></div>
              <div className="score-block">
                <ScoreTable title="Batting" headers={['Player', 'R', 'B', 'Status']} rows={state.batting.map(p => [p.name, p.runs, p.balls, p.status])} />
              </div>
              <div className="score-block">
                <ScoreTable title="Bowling" headers={['Bowler', 'O', 'R', 'W']} rows={state.bowling.map(p => [p.name, oversFromBalls(p.balls), p.runs, p.wickets])} />
              </div>
              <div className="score-block result-block"><h3>Result</h3><p>{matchResult(match)}</p></div>
            </section>

            <section className="panel commentary-panel">
              <h2>Commentary</h2>
              {match.innings.filter(inn => inn.completed || inn.balls.length > 0).map((inn) => {
                const inningsIndex = inn.number - 1
                const innState = computeState(clone(match), clone(inn))
                return (
                  <details key={inn.number} className="over-card">
                    <summary>Innings {inn.number} ({teamLabel(inn.battingTeamKey)}) · {innState.summary.totalRuns}/{innState.summary.wickets}</summary>
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
            </section>

            <PlayerManagement match={match} onRename={startRename} onAdd={openAddPlayer} onMove={openMovePlayer} />
          </aside>
        </main>
      ))}

      {activeView === 'games' && <GamesPanel history={history} openSavedMatch={openSavedMatch} />}
      {activeView === 'analytics' && <AnalyticsPanel history={history} />}

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

      {playerDialogOpen && match && (
        <div className="dialog-backdrop"><div className="dialog">
          <h3>{playerDialogMode === 'move' ? 'Move player' : 'Add player'}</h3>
          <label>Player name<input value={playerName} onChange={e => setPlayerName(e.target.value)} disabled={playerDialogMode === 'move'} placeholder="Player name" /></label>
          <label>Team<select value={playerTargetTeam} onChange={e => setPlayerTargetTeam(e.target.value)}><option value="team1">Team 1</option><option value="team2">Team 2</option><option value="shared">Shared</option></select></label>
          <div className="actions-row"><button className="secondary" onClick={() => setPlayerDialogOpen(false)}>Cancel</button><button onClick={savePlayerDialog}>{playerDialogMode === 'move' ? 'Move Player' : 'Add Player'}</button></div>
        </div></div>
      )}
    </div>
  )
}




function SyncBadge({ status }) {
  const labels = { local: 'Local', syncing: 'Syncing', synced: 'Synced', failed: 'Sync failed' }
  return <span className={'sync-badge ' + status}>{labels[status] || 'Local'}</span>
}

function CopySummaryButton({ match, label = 'Copy Summary', summaryLabel = 'Cricket Match' }) {
  const [copied, setCopied] = useState(false)
  async function copySummary() {
    const text = buildMatchSummaryText(match, summaryLabel)
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
      else window.prompt('Copy match summary', text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch (error) {
      window.prompt('Copy match summary', text)
    }
  }
  return <button className="secondary small-button" onClick={copySummary}>{copied ? 'Copied' : label}</button>
}

function CopyScorecardImageButton({ targetId }) {
  const [status, setStatus] = useState('')

  async function copyImage(event) {
    event.preventDefault()
    event.stopPropagation()
    const node = document.getElementById(targetId)
    if (!node) return
    setStatus('Preparing')
    try {
      const dataUrl = await toPng(node, {
        backgroundColor: '#ffffff',
        cacheBust: true,
        pixelRatio: 2,
      })
      const response = await fetch(dataUrl)
      const blob = await response.blob()
      const downloadImage = () => {
        const link = document.createElement('a')
        link.href = dataUrl
        link.download = 'cricket-scorecard.png'
        link.click()
      }
      if (navigator.clipboard?.write && window.ClipboardItem) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          setStatus('Copied image')
        } catch (error) {
          downloadImage()
          setStatus('Downloaded')
        }
      } else {
        downloadImage()
        setStatus('Downloaded')
      }
    } catch (error) {
      console.error('Failed to copy scorecard image', error)
      setStatus('Copy failed')
    }
    window.setTimeout(() => setStatus(''), 2200)
  }

  return <button className="secondary small-button image-copy-button" onClick={copyImage}>{status || 'Copy Scorecard Image'}</button>
}

function MatchSummaryCard({ match, title = 'Match Summary', compact = false }) {
  const highlight = matchHighlights(match)
  if (!highlight) return null
  const wicketRows = Object.entries(highlight.totals.wicketTypes).filter(([, count]) => count > 0)
  return (
    <section className={compact ? 'summary-card compact-summary' : 'summary-card'}>
      <div className="panel-head compact-head">
        <div>
          <div className="panel-kicker">Result</div>
          <h2>{title}</h2>
        </div>
        <CopySummaryButton match={match} summaryLabel={title} />
      </div>
      <p className="result-line">{highlight.result}</p>
      <div className="summary-scoreline">{formatScoreLine(highlight)}</div>
      <div className="summary-grid">
        <Stat label="Top Scorer" value={highlight.topScorer ? highlight.topScorer.name + ' ' + highlight.topScorer.runs : '—'} />
        <Stat label="Best Bowler" value={highlight.bestBowler ? highlight.bestBowler.name + ' ' + highlight.bestBowler.wickets + 'w' : '—'} />
        <Stat label="Extras" value={highlight.totals.extras} />
        <Stat label="4s / 6s" value={highlight.totals.fours + ' / ' + highlight.totals.sixes} />
      </div>
      <div className="wicket-pills">
        {wicketRows.length === 0 ? <span>No wickets</span> : wicketRows.map(([type, count]) => <span key={type}>{type}: {count}</span>)}
      </div>
    </section>
  )
}

function PlayerManagement({ match, onRename, onAdd, onMove }) {
  const rows = playerDirectory(match)
  return (
    <section className="panel player-panel">
      <div className="panel-head compact-head"><h2>Players</h2><button className="secondary small-button" onClick={onAdd}>Add Player</button><span className="badge">{rows.length} names</span></div>
      {rows.length === 0 ? <p className="muted">No players yet.</p> : (
        <div className="player-table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Team</th><th>Type</th><th></th></tr></thead>
            <tbody>{rows.map(row => (
              <tr key={row.team + '-' + row.name}>
                <td>{row.name}</td><td>{row.team}</td><td>{row.source}</td>
                <td><div className="row-actions"><button className="secondary small-button" onClick={() => onRename(row.name)}>Rename</button><button className="secondary small-button" onClick={() => onMove(row.name)}>Move</button></div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function GamesPanel({ history, openSavedMatch }) {
  return (
    <main className="view-stack">
      <section className="panel games-panel">
        <div className="panel-head">
          <div>
            <div className="panel-kicker">Archive</div>
            <h2>Completed Games</h2>
          </div>
          <span className="badge">{history.length} saved</span>
        </div>
        <div className="saved-list">
          {history.length === 0 ? <p className="muted">No saved matches yet.</p> : history.map((item, index) => {
            const savedMatch = item.match || item
            const displayDate = formatMatchDate(item.savedAt || savedMatch.savedAt || savedMatch.updated_at || savedMatch.createdAt)
            const scorecardTargetId = `scorecard-${item.id || item.gameNumber || index}`
            return (
              <details className="saved-item history-item" key={item.id}>
                <summary>
                  <span className="saved-summary"><span className="saved-date">{displayDate}</span><strong>Game {item.gameNumber || '—'}</strong><span>{matchResult(savedMatch)}</span></span>
                  <span className="saved-actions">
                    <button className="secondary small-button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openSavedMatch(item) }}>Open / Edit</button>
                  </span>
                </summary>
                <MatchSummaryCard match={savedMatch} title={'Game ' + (item.gameNumber || '—')} compact />
                <div className="detail-actions"><CopyScorecardImageButton targetId={scorecardTargetId} /></div>
                <div id={scorecardTargetId} className="scorecard-export-target">
                  <div className="export-title">
                    <span>{displayDate}</span>
                    <strong>Game {item.gameNumber || '—'} · {matchResult(savedMatch)}</strong>
                  </div>
                  <div className="history-grid">
                    {isValidMatch(savedMatch) && savedMatch.innings.map((inn) => {
                      const savedState = computeState(clone(savedMatch), clone(inn))
                      return (
                        <div className="mini-card scorecard-innings-card" key={inn.number}>
                          <div className="innings-card-head">
                            <h3>Innings {inn.number} · {teamLabel(inn.battingTeamKey)}</h3>
                            <span>{savedState.summary.totalRuns}/{savedState.summary.wickets}</span>
                          </div>
                          <p className="muted small">Overs {savedState.summary.overs} · Extras {savedState.summary.extras}</p>
                          <ScoreTable title="Batting" headers={['Player', 'R', 'B', 'Status']} rows={savedState.batting.map(p => [p.name, p.runs, p.balls, p.status])} />
                          <ScoreTable title="Bowling" headers={['Bowler', 'O', 'R', 'W']} rows={savedState.bowling.map(p => [p.name, oversFromBalls(p.balls), p.runs, p.wickets])} />
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="history-commentary-grid">
                  {isValidMatch(savedMatch) && savedMatch.innings.map((inn) => (
                    <div className="commentary-block" key={'commentary-' + inn.number}>
                      <h3>Innings {inn.number} Commentary</h3>
                      {inn.balls.length === 0 ? <p className="muted small">No commentary</p> : inn.balls.map((ball, index) => (
                        <div className="commentary-line" key={ball.id}><strong>{legalBallLabel(index, inn)}</strong> · {ball.raw}</div>
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            )
          })}
        </div>
      </section>
    </main>
  )
}

function PlayerChip({ label, value, active = false }) {
  return <div className={active ? 'player-chip active' : 'player-chip'}><span>{label}</span><strong>{value}</strong></div>
}

function QuickGroup({ title, items, onPick, extraAction = null }) {
  return (
    <div className="quick-group">
      <div className="quick-title">{title}</div>
      <div className="quick-buttons">
        {items.map(([label, value]) => <button key={label} className="secondary quick-button" onClick={() => onPick(value)}>{label}</button>)}
        {extraAction}
      </div>
    </div>
  )
}

function AnalyticsPanel({ history }) {
  const completedItems = useMemo(() => normalizeHistoryItems(history).filter(item => item.match.completed || item.match.innings?.[1]?.completed), [history])
  const [selectedMatchId, setSelectedMatchId] = useState('all')
  const [selectedTeam, setSelectedTeam] = useState('all')
  const [playerFilter, setPlayerFilter] = useState('')
  const analytics = useMemo(() => analyzeMatches(completedItems, { matchId: selectedMatchId, team: selectedTeam, player: playerFilter }), [completedItems, selectedMatchId, selectedTeam, playerFilter])
  const totals = analytics.totals
  const battingLeaders = [...analytics.battingRows].sort((a, b) => b.runs - a.runs).slice(0, 8)
  const strikeLeaders = [...analytics.battingRows].filter(p => p.balls > 0).sort((a, b) => safeDivide(b.runs * 100, b.balls) - safeDivide(a.runs * 100, a.balls)).slice(0, 8)
  const bowlingLeaders = [...analytics.bowlingRows].sort((a, b) => b.wickets - a.wickets || safeDivide(a.runs, a.balls / BALLS_PER_OVER, 999) - safeDivide(b.runs, b.balls / BALLS_PER_OVER, 999)).slice(0, 8)
  const economyLeaders = [...analytics.bowlingRows].filter(p => p.balls >= BALLS_PER_OVER).sort((a, b) => safeDivide(a.runs, a.balls / BALLS_PER_OVER) - safeDivide(b.runs, b.balls / BALLS_PER_OVER)).slice(0, 8)
  const selectedBattingPlayer = playerFilter ? analytics.battingRows.find(p => p.name.toLowerCase() === playerFilter.trim().toLowerCase()) || analytics.battingRows[0] : null
  const selectedBowlingPlayer = selectedBattingPlayer ? analytics.bowlingRows.find(p => p.name === selectedBattingPlayer.name) : null
  const recentMatches = analytics.matchBreakdowns.slice(0, 5)
  const maxOverRuns = Math.max(1, ...analytics.matchBreakdowns.flatMap(match => match.innings.flatMap(inn => inn.overs.map(over => over.totalRuns))))

  useEffect(() => {
    if (selectedMatchId !== 'all' && !completedItems.some(item => item.id === selectedMatchId)) setSelectedMatchId('all')
  }, [completedItems, selectedMatchId])

  return (
    <section className="panel analytics-panel">
      <div className="panel-head">
        <div>
          <h2>Analytics</h2>
          <p className="muted small">Read-only stats from completed saved games.</p>
        </div>
        <span className="badge">{completedItems.length} completed</span>
      </div>

      {completedItems.length === 0 ? (
        <p className="muted">No completed matches yet. Finish a match and it will appear here automatically.</p>
      ) : (
        <>
          <div className="analytics-filters">
            <label>Match<select value={selectedMatchId} onChange={e => setSelectedMatchId(e.target.value)}>
              <option value="all">All completed matches</option>
              {completedItems.map(item => <option key={item.id} value={item.id}>{formatMatchDate(item.savedAt || item.match.createdAt)} · Game {item.gameNumber || '—'}</option>)}
            </select></label>
            <label>Team<select value={selectedTeam} onChange={e => setSelectedTeam(e.target.value)}>
              <option value="all">Both teams</option>
              <option value="team1">Team 1</option>
              <option value="team2">Team 2</option>
            </select></label>
            <label>Player filter<input value={playerFilter} onChange={e => setPlayerFilter(e.target.value)} placeholder="Search player" /></label>
          </div>

          <div className="stats-grid analytics-stats">
            <Stat label="Runs" value={totals.runs} />
            <Stat label="Wickets" value={totals.wickets} />
            <Stat label="Run Rate" value={formatRate(safeDivide(totals.runs, totals.legalBalls / BALLS_PER_OVER))} />
            <Stat label="Extras" value={totals.extras} />
            <Stat label="4s / 6s" value={`${totals.fours} / ${totals.sixes}`} />
            <Stat label="Singles / Doubles" value={`${totals.singles} / ${totals.doubles}`} />
            <Stat label="Dots" value={totals.dots} />
            <Stat label="Caught Outs" value={totals.catches} />
            <Stat label="Dot %" value={formatRate(safeDivide(totals.dots * 100, totals.legalBalls))} />
            <Stat label="Boundary %" value={formatRate(safeDivide((totals.fours + totals.sixes) * 100, totals.legalBalls))} />
            <Stat label="Wides / No Balls" value={totals.wides + ' / ' + totals.noBalls} />
            <Stat label="Matches" value={totals.matches} />
          </div>

          <div className="team-card-grid">
            {analytics.teamRows.map(team => (
              <div className="team-card" key={team.name}>
                <div className="panel-kicker">{team.name}</div>
                <strong>{team.wins}-{team.losses}{team.ties ? '-' + team.ties : ''}</strong>
                <span>Avg score {formatRate(safeDivide(team.runsFor, team.matches))} · Boundaries {team.boundaries}</span>
              </div>
            ))}
          </div>

          {selectedBattingPlayer && (
            <section className="player-drilldown">
              <div className="panel-head compact-head"><h3>{selectedBattingPlayer.name}</h3><span className="badge">Player detail</span></div>
              <div className="stats-grid analytics-stats">
                <Stat label="Bat Runs" value={selectedBattingPlayer.runs} />
                <Stat label="Strike Rate" value={formatRate(safeDivide(selectedBattingPlayer.runs * 100, selectedBattingPlayer.balls))} />
                <Stat label="Boundaries" value={(selectedBattingPlayer.fours || 0) + (selectedBattingPlayer.sixes || 0)} />
                <Stat label="Bowl Econ" value={selectedBowlingPlayer ? formatRate(safeDivide(selectedBowlingPlayer.runs, selectedBowlingPlayer.balls / BALLS_PER_OVER)) : '—'} />
              </div>
            </section>
          )}

          <div className="analytics-grid">
            <ScoreTable title="Team Results" headers={['Team', 'M', 'W', 'L', 'T', 'Runs', 'Wkts', 'Boundaries']} rows={analytics.teamRows.map(team => [team.name, team.matches, team.wins, team.losses, team.ties, `${team.runsFor}/${team.runsAgainst}`, `${team.wicketsTaken}/${team.wicketsLost}`, team.boundaries])} />
            <ScoreTable title="Top Run Scorers" headers={['Player', 'Inn', 'R', 'B', 'SR', '4s', '6s']} rows={battingLeaders.map(p => [p.name, p.innings, p.runs, p.balls, formatRate(safeDivide(p.runs * 100, p.balls)), p.fours, p.sixes])} />
            <ScoreTable title="Strike Rate" headers={['Player', 'R', 'B', 'SR', '1s', '2s', 'NO']} rows={strikeLeaders.map(p => [p.name, p.runs, p.balls, formatRate(safeDivide(p.runs * 100, p.balls)), p.singles, p.doubles, p.notOuts])} />
            <ScoreTable title="Bowling Wickets" headers={['Bowler', 'O', 'R', 'W', 'Econ', 'Dots']} rows={bowlingLeaders.map(p => [p.name, oversFromBalls(p.balls), p.runs, p.wickets, formatRate(safeDivide(p.runs, p.balls / BALLS_PER_OVER)), p.dots])} />
            <ScoreTable title="Economy" headers={['Bowler', 'O', 'R', 'W', 'Econ', 'C/B']} rows={economyLeaders.map(p => [p.name, oversFromBalls(p.balls), p.runs, p.wickets, formatRate(safeDivide(p.runs, p.balls / BALLS_PER_OVER)), `${p.caught}/${p.bowled}`])} />
            <ScoreTable title="Wicket Types" headers={['Type', 'Count']} rows={Object.entries(analytics.wicketTypes).map(([type, count]) => [type, count])} />
          </div>

          <section className="recent-form">
            <div className="panel-head compact-head"><h3>Recent Form</h3><span className="badge">Last {recentMatches.length}</span></div>
            {recentMatches.length === 0 ? <p className="muted">No recent matches for these filters.</p> : recentMatches.map(match => (
              <div className="recent-row" key={match.id}><strong>Game {match.gameNumber || '—'}</strong><span>{match.result}</span></div>
            ))}
          </section>

          <div className="match-analytics-list">
            {analytics.matchBreakdowns.length === 0 ? <p className="muted">No analytics match the current filters.</p> : analytics.matchBreakdowns.map(match => (
              <details className="analytics-match" key={match.id}>
                <summary><strong>{formatMatchDate(match.savedAt)} · Game {match.gameNumber || '—'}</strong><span>{match.result}</span></summary>
                <div className="innings-bars">
                  {match.innings.map(inn => (
                    <div className="mini-card" key={inn.innings.number}>
                      <h3>Innings {inn.innings.number} · {inn.battingTeam}</h3>
                      <p className="muted small">{inn.state.summary.totalRuns}/{inn.state.summary.wickets} in {inn.state.summary.overs} · RR {formatRate(safeDivide(inn.state.summary.totalRuns, inn.state.summary.legalBalls / BALLS_PER_OVER))} · Extras {inn.state.summary.extras}</p>
                      <div className="bar-list">
                        {inn.overs.length === 0 ? <p className="muted small">No overs recorded.</p> : inn.overs.map(over => (
                          <div className="over-bar-row" key={over.over}>
                            <span>Over {over.over}</span>
                            <div className="over-bar-track"><div className="over-bar-fill" style={{ width: `${Math.max(6, (over.totalRuns / maxOverRuns) * 100)}%` }} /></div>
                            <strong>{over.totalRuns}</strong>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </>
      )}
    </section>
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
