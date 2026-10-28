import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cardToPersona, readPngChara } from '../lib/core/charcard.js'
import { PRESETS } from '../lib/core/personality.js'
import { resolveConfig } from '../lib/config.js'
import { CerebrumService } from '../lib/service.js'

const genomes = Object.fromEntries(Object.entries(PRESETS).map(([key, value]) => [key, value.traits]))

test('charcard: free-text personality maps onto the Big Five and a preset', () => {
  const card = {
    name: '小狐',
    description: '一只温柔体贴的小狐狸，总是元气满满地陪在主人身边',
    personality: '温柔、热情、忠诚，偶尔有点冒失',
    first_meshal: '主人！今天也要一起加油哦～',
  }
  const persona = cardToPersona(card, { presetGenomes: genomes })
  assert.equal(persona.name, '小狐')
  assert.ok(persona.traits.agreeableness > 0.5, '温柔/热情/忠诚 should raise agreeableness')
  assert.ok(persona.traits.extraversion > 0.5, '元气 should raise extraversion')
  assert.equal(persona.preset, 'warm-companion')
  assert.match(persona.identity, /温柔/)
  assert.equal(persona.voice, card.first_meshal)
})

test('charcard: tsundere maps away from agreeableness', () => {
  const persona = cardToPersona({ name: 'K', personality: 'tsundere, sarcastic, cold on the outside', first_meshal: 'Hmph.' }, { presetGenomes: genomes })
  assert.ok(persona.traits.agreeableness < 0.5)
})

test('charcard: PNG cards carry the chara JSON in a tEXt chunk', () => {
  const card = { name: '像素猫', description: '冷静认真的电子猫', personality: 'calm, diligent', first_meshal: '喵。' }

  // minimal PNG: signature + IHDR + tEXt(chara) + IEND
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  const text = Buffer.concat([Buffer.from('chara\0', 'ascii'), Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'ascii')])
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IEND', Buffer.alloc(0)),
  ])

  const parsed = readPngChara(png)
  assert.equal(parsed.name, '像素猫')
  const persona = cardToPersona(png, { presetGenomes: genomes })
  assert.equal(persona.name, '像素猫')
  assert.ok(persona.traits.neuroticism < 0.5, 'calm should lower neuroticism')
})

test('charcard: import and apply replaces the global persona and identity', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-card-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws'), personality: { preset: 'curious-engineer' } }))
  const session = { id: 'card', header: { cwd: path.join(home, 'ws') } }
  service.onSessionEvent(session, { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } } })

  const card = { name: '管家', description: '冷静严谨的机械管家', personality: 'cold, calm, diligent', first_meshal: '主人，请吩咐。' }
  const persona = service.importCard(card, { sessionId: session.id })
  assert.ok(service.self.cards.some((entry) => entry.name === '管家'))

  const applied = service.applyCard('管家', { sessionId: session.id })
  assert.equal(applied.preset, 'stoic-guardian')
  const profile = service.profile('get', {}, { sessionId: session.id })
  assert.equal(profile.personality.preset, 'stoic-guardian')
  assert.match(service.self.identity, /管家/)
  const prompt = service.renderPromptState(session.id)
  assert.match(prompt, /克制|守门/, 'the prompt reflects the adopted character')

  // A card file path round-trips through the tool helper too.
  const cardFile = path.join(home, 'card.json')
  fs.writeFileSync(cardFile, JSON.stringify(card))
  const bytes = service.readFile(cardFile)
  assert.equal(cardToPersona(JSON.parse(bytes.toString('utf8')), { presetGenomes: genomes }).name, '管家')
  service.dispose()
})
