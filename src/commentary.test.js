import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMENTARY_VARIATION_COUNT, generateBallCommentary } from './commentary.js'

function ball(overrides = {}) {
  return {
    id: 'ball-1',
    raw: 'Single by Jay',
    batter: 'Jay',
    bowler: 'Sam',
    runsOffBat: 1,
    extras: 0,
    extraType: '',
    wicket: false,
    dismissalType: '',
    dismissalPlayer: '',
    legalBall: true,
    ...overrides,
  }
}

test('offers at least 250 local commentary combinations', () => {
  assert.ok(COMMENTARY_VARIATION_COUNT >= 250)
})

test('generates outcome commentary without changing raw input', () => {
  const event = ball()
  const original = event.raw
  const generated = generateBallCommentary(event)
  assert.match(generated.text, /^Sam to Jay, 1 run\./)
  assert.equal(event.raw, original)
})

test('honors explicit shot cues', () => {
  const generated = generateBallCommentary(ball({ raw: 'Jay takes a single with an inside edge toward square leg' }))
  assert.match(generated.text, /inside edge/i)
  assert.match(generated.text, /square leg/i)
})

test('covers extras and wickets', () => {
  assert.match(generateBallCommentary(ball({ raw: 'Wide', extraType: 'wide', extras: 1, runsOffBat: 0 })).text, /wide/i)
  assert.match(generateBallCommentary(ball({ raw: 'No ball', extraType: 'no-ball', legalBall: false, runsOffBat: 2 })).text, /no-ball/i)
  assert.match(generateBallCommentary(ball({ raw: 'Jay bowled', wicket: true, dismissalType: 'bowled', dismissalPlayer: 'Jay', runsOffBat: 0 })).text, /OUT — bowled/i)
  assert.match(generateBallCommentary(ball({ raw: 'Jay caught', wicket: true, dismissalType: 'caught', dismissalPlayer: 'Jay', runsOffBat: 0 })).text, /OUT — caught/i)
  assert.match(generateBallCommentary(ball({ raw: 'Jay run out', wicket: true, dismissalType: 'run out', dismissalPlayer: 'Jay', runsOffBat: 1 })).text, /1 run was completed/i)
})

test('avoids recently used template families', () => {
  const first = ball({ id: 'same-seed' })
  const generated = generateBallCommentary(first)
  const next = generateBallCommentary(ball({ id: 'same-seed' }), [{ ...first, commentaryTemplateId: generated.templateId }])
  assert.notEqual(next.templateId, generated.templateId)
})

test('keeps commentary to at most two sentences', () => {
  const cases = [
    ball(),
    ball({ raw: 'Dot by Jay', runsOffBat: 0 }),
    ball({ raw: 'Jay drives through cover for four', runsOffBat: 4 }),
    ball({ raw: 'No ball', extraType: 'no-ball', legalBall: false, runsOffBat: 2 }),
    ball({ raw: 'Jay run out', wicket: true, dismissalType: 'run out', dismissalPlayer: 'Jay', runsOffBat: 1 }),
  ]
  cases.forEach(event => {
    const sentenceCount = generateBallCommentary(event).text.split(/[.!?]+\s*/).filter(Boolean).length
    assert.ok(sentenceCount <= 2)
  })
})
