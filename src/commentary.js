const AREAS = ['cover', 'point', 'mid-wicket', 'square leg', 'long-on', 'third man', 'fine leg', 'the off side']

const SHOTS = {
  single: [
    ['nudges', 'mid-wicket'], ['works', 'square leg'], ['guides', 'third man'], ['pushes', 'cover'],
    ['clips', 'fine leg'], ['steers', 'point'], ['punches', 'the off side'], ['turns', 'mid-wicket'],
    ['dabs', 'third man'], ['drives', 'long-on'], ['tucks', 'square leg'], ['places', 'cover'],
  ],
  double: [
    ['drives', 'cover'], ['pulls', 'mid-wicket'], ['cuts', 'point'], ['clips', 'square leg'],
    ['guides', 'third man'], ['works', 'fine leg'], ['pushes', 'the off side'], ['punches', 'long-on'],
  ],
  triple: [
    ['drives', 'cover'], ['cuts', 'point'], ['pulls', 'mid-wicket'], ['clips', 'square leg'],
    ['guides', 'third man'], ['works', 'fine leg'],
  ],
  four: [
    ['drives firmly', 'cover'], ['cuts crisply', 'point'], ['pulls powerfully', 'mid-wicket'],
    ['clips neatly', 'square leg'], ['guides late', 'third man'], ['flicks fine', 'fine leg'],
    ['punches cleanly', 'the off side'], ['strikes straight', 'long-on'], ['sweeps strongly', 'square leg'],
    ['carves away', 'point'], ['pushes firmly', 'cover'], ['turns neatly', 'mid-wicket'],
  ],
  six: [
    ['launches', 'long-on'], ['pulls high', 'mid-wicket'], ['swings cleanly', 'square leg'],
    ['lofts', 'cover'], ['sends it soaring', 'the off side'], ['gets under the ball and launches it', 'long-on'],
    ['strikes powerfully', 'mid-wicket'], ['sweeps powerfully', 'square leg'],
  ],
}

const ENDINGS = {
  single: ['They cross comfortably.', 'They complete a well-judged single.', 'The strike rotates.', 'One run is added.'],
  double: ['They return comfortably for two.', 'Good running completes the second.', 'The pair come back for a brace.'],
  triple: ['Excellent running brings three.', 'They push hard and complete the third.', 'Determined running produces three.'],
  four: ['The ball runs away to the boundary.', 'There is no stopping it before the rope.', 'It beats the field and reaches the fence.'],
  six: ['It clears the boundary comfortably.', 'That sails all the way for six.', 'The ball disappears beyond the rope.'],
}

const DOT_ACTIONS = [
  'defends with a straight bat', 'meets it with a compact defence', 'plays it softly', 'checks the stroke',
  'stays watchful and blocks', 'pushes with control', 'gets safely behind the line', 'keeps it out',
]
const DOT_TARGETS = ['back toward the bowler', 'into the off side', 'toward cover', 'to mid-wicket']
const DOT_ENDINGS = ['No run available.', 'The field closes it down.', 'There is no opening for a run.', 'The batters stay put.']

const WIDE_LINES = [
  'The delivery strays beyond reach and must be bowled again.',
  'That is outside the scoring arc and the umpire calls it wide.',
  'Too far from the batter, and an extra is added.',
  'The bowler loses the line and concedes a wide.',
  'The ball is out of reach, bringing an extra delivery.',
  'A wayward delivery gives the batting side an extra.',
]
const NO_BALL_LINES = [
  'The delivery does not count and the bowler will have to send down another.',
  'The umpire signals no-ball, so an extra delivery follows.',
  'It is called a no-ball and the ball must be rebowled.',
  'The bowler oversteps the mark and the delivery will not count.',
  'A no-ball is signalled, giving the batter another opportunity.',
  'The illegal delivery is called and another ball is required.',
]
const CAUGHT_LINES = [
  'The shot goes in the air and the chance is safely taken.',
  'A miscued stroke produces a catch and the batter has to go.',
  'The attempted attacking shot ends with a clean catch.',
  'The ball is lifted into the field and the opportunity is held.',
  'The batter cannot keep the shot down and is caught.',
  'An aerial stroke brings the innings to an end.',
]
const BOWLED_LINES = [
  'The ball gets through and disturbs the stumps.',
  'The batter is beaten and the stumps are struck.',
  'It sneaks past the bat and crashes into the wicket.',
  'The defence is breached and the batter is bowled.',
  'The bowler finds a way through to hit the stumps.',
  'The attempted stroke misses and the wicket is broken.',
]
const RUN_OUT_LINES = [
  'The running falls short and {out} cannot make the ground.',
  '{out} is caught short while trying to complete the run.',
  'The fielding side completes the run out before {out} can get home.',
  'A tight call ends with {out} short of the crease.',
  'The batters take on the run, but {out} is run out.',
  'The attempted run proves costly as {out} is caught short.',
]
const MISSED_CHANCE_LINES = [
  'A run-out opportunity appears, but the fielding side cannot complete it.',
  'There is a chance to break the wicket, but the opportunity goes begging.',
  'The batters survive a run-out chance and remain at the crease.',
  'A possible run out is missed, allowing the batters to escape.',
]

function normalize(value) {
  return (value || '').toLowerCase().replace(/[.,!?;:()]/g, ' ').replace(/\s+/g, ' ').trim()
}

function hashString(value) {
  let hash = 2166136261
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function stripPeriod(value) {
  return String(value || '').trim().replace(/[.!?]+$/, '')
}

function lowerFirst(value) {
  const text = stripPeriod(value)
  return text ? text[0].toLowerCase() + text.slice(1) : ''
}

function joinDescription(first, second, connector = '; ', lowercaseSecond = true) {
  return `${stripPeriod(first)}${connector}${lowercaseSecond ? lowerFirst(second) : stripPeriod(second)}.`
}

function addShotObject(action) {
  if (/\bit\b|\bthe ball\b/.test(action)) return action
  const words = action.split(' ')
  const modifier = words.at(-1)
  if (['firmly', 'crisply', 'powerfully', 'neatly', 'late', 'fine', 'cleanly', 'straight', 'strongly', 'away', 'high', 'over'].includes(modifier)) {
    return `${words.slice(0, -1).join(' ')} it ${modifier}`
  }
  return `${action} it`
}

function resultLabel(ball) {
  const batter = ball.batter || 'Batter'
  const bowler = ball.bowler || 'Bowler'
  if (ball.wicket) return `${bowler} to ${batter}, OUT — ${ball.dismissalType || 'wicket'}.`
  if (ball.extraType === 'wide') return `${bowler} to ${batter}, ${ball.extras > 1 ? `${ball.extras} wides` : 'wide'}.`
  if (ball.extraType === 'no-ball') {
    const runs = Number(ball.runsOffBat || 0)
    return `${bowler} to ${batter}, no-ball${runs ? `, ${runs} run${runs === 1 ? '' : 's'} off the bat` : ''}.`
  }
  const runs = Number(ball.runsOffBat || 0)
  if (runs === 0) return `${bowler} to ${batter}, no run.`
  if (runs === 4) return `${bowler} to ${batter}, FOUR.`
  if (runs === 6) return `${bowler} to ${batter}, SIX.`
  return `${bowler} to ${batter}, ${runs} run${runs === 1 ? '' : 's'}.`
}

function explicitBody(ball) {
  const raw = normalize(ball.raw)
  const batter = ball.batter || 'The batter'
  const runs = Number(ball.runsOffBat || 0)
  const area = AREAS.find(value => raw.includes(value))
  if (raw.includes('run out chance missed') || raw.includes('runout chance missed') || raw.includes('missed run out')) {
    return { family: 'explicit-missed-run-out', text: MISSED_CHANCE_LINES[0] }
  }
  if (raw.includes('play and miss') || raw.includes('plays and misses') || raw.includes('beaten')) {
    return { family: 'explicit-beaten', text: `${batter} plays at it but cannot make contact.` }
  }
  if (raw.includes('inside edge')) {
    const ending = runs ? `They complete ${runs === 1 ? 'a single' : `${runs} runs`}.` : 'No run is available.'
    return { family: 'explicit-inside-edge', text: joinDescription(`${batter} gets an inside edge${area ? ` toward ${area}` : ''}`, ending) }
  }
  if (raw.includes('caught behind')) {
    return { family: 'explicit-caught-behind', text: `${batter} gets an edge behind and the chance is taken.` }
  }
  const verbs = [
    ['slap', 'slaps'], ['drive', 'drives'], ['pull', 'pulls'], ['cut', 'cuts'], ['sweep', 'sweeps'],
    ['flick', 'flicks'], ['guide', 'guides'], ['nudge', 'nudges'], ['tuck', 'tucks'], ['punch', 'punches'],
  ]
  const verb = verbs.find(([cue]) => raw.includes(cue))
  if (verb) {
    let ending = 'The field prevents any run.'
    if (runs === 1) ending = 'They cross for a single.'
    else if (runs === 2) ending = 'They come back for two.'
    else if (runs === 3) ending = 'Good running brings three.'
    else if (runs === 4) ending = 'It reaches the boundary.'
    else if (runs === 6) ending = 'It clears the boundary.'
    return { family: `explicit-${verb[0]}`, text: joinDescription(`${batter} ${verb[1]} it${area ? ` toward ${area}` : ' away'}`, ending) }
  }
  if (raw.includes('out of the park')) return { family: 'explicit-out-of-park', text: `${batter} gets hold of it and sends it beyond the boundary.` }
  return null
}

function buildCandidates(ball) {
  const batter = ball.batter || 'The batter'
  const runs = Number(ball.runsOffBat || 0)
  const raw = normalize(ball.raw)
  if (raw.includes('run out chance missed') || raw.includes('runout chance missed') || raw.includes('missed run out')) {
    return MISSED_CHANCE_LINES.map((text, index) => ({ family: `missed-chance-${index}`, text }))
  }
  if (ball.wicket && ball.dismissalType === 'run out') {
    const out = ball.dismissalPlayer || batter
    const completed = runs ? ` ${runs} run${runs === 1 ? ' was' : 's were'} completed before the wicket.` : ''
    return RUN_OUT_LINES.map((line, index) => ({
      family: `run-out-${index}`,
      text: completed ? joinDescription(line.replaceAll('{out}', out), completed) : line.replaceAll('{out}', out),
    }))
  }
  if (ball.wicket && ball.dismissalType === 'bowled') return BOWLED_LINES.map((text, index) => ({ family: `bowled-${index}`, text }))
  if (ball.wicket && ball.dismissalType === 'caught') return CAUGHT_LINES.map((text, index) => ({ family: `caught-${index}`, text }))
  if (ball.wicket) return [{ family: 'wicket-generic', text: `${ball.dismissalPlayer || batter} is dismissed and has to leave the crease.` }]
  if (ball.extraType === 'wide') return WIDE_LINES.map((text, index) => ({ family: `wide-${index}`, text }))
  if (ball.extraType === 'no-ball') {
    return NO_BALL_LINES.map((text, index) => ({ family: `no-ball-${index}`, text }))
  }
  if (runs === 0) {
    return DOT_ACTIONS.flatMap((action, actionIndex) => DOT_TARGETS.flatMap(target => DOT_ENDINGS.map(ending => ({
      family: `dot-${actionIndex}`,
      text: joinDescription(`${batter} ${action} ${target}`, ending),
    }))))
  }
  const kind = runs === 1 ? 'single' : runs === 2 ? 'double' : runs === 3 ? 'triple' : runs === 4 ? 'four' : runs === 6 ? 'six' : 'single'
  return (SHOTS[kind] || SHOTS.single).flatMap(([action, area], actionIndex) => ENDINGS[kind].map(ending => {
    const shot = addShotObject(action)
    const direction = kind === 'six' ? `over ${area}` : `toward ${area}`
    return { family: `${kind}-${actionIndex}`, text: joinDescription(`${batter} ${shot} ${direction}`, ending, ', and ') }
  }))
}

export function generateBallCommentary(ball, recentBalls = [], options = {}) {
  const prefix = resultLabel(ball)
  const explicit = explicitBody(ball)
  if (explicit) return { text: `${prefix} ${explicit.text}`, templateId: explicit.family }

  const candidates = buildCandidates(ball)
  const recentFamilies = new Set(recentBalls.slice(-6).map(item => item.commentaryTemplateId).filter(Boolean))
  const sameOutcomeFamilies = new Set(recentBalls.filter(item => commentaryKind(item) === commentaryKind(ball)).slice(-3).map(item => item.commentaryTemplateId).filter(Boolean))
  const available = candidates.filter(candidate => !recentFamilies.has(candidate.family) && !sameOutcomeFamilies.has(candidate.family))
  const pool = available.length ? available : candidates
  const offset = Number(options.variantOffset || 0)
  const selected = pool[(hashString(`${ball.id || ball.raw}:${commentaryKind(ball)}`) + offset) % pool.length]
  return { text: `${prefix} ${selected.text}`, templateId: selected.family }
}

export function commentaryKind(ball) {
  const raw = normalize(ball.raw)
  if (raw.includes('run out chance missed') || raw.includes('runout chance missed') || raw.includes('missed run out')) return 'missed-chance'
  if (ball.wicket) return ball.dismissalType || 'wicket'
  if (ball.extraType) return ball.extraType
  return `runs-${Number(ball.runsOffBat || 0)}`
}

export const COMMENTARY_VARIATION_COUNT =
  DOT_ACTIONS.length * DOT_TARGETS.length * DOT_ENDINGS.length +
  Object.entries(SHOTS).reduce((total, [kind, shots]) => total + shots.length * ENDINGS[kind].length, 0) +
  WIDE_LINES.length + NO_BALL_LINES.length + CAUGHT_LINES.length + BOWLED_LINES.length + RUN_OUT_LINES.length + MISSED_CHANCE_LINES.length
