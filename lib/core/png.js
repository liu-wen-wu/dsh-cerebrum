/**
 * Minimal PNG codec (8-bit, non-interlaced, RGB/RGBA/gray) using node:zlib.
 *
 * Why: transparent expressions need alpha, and the pet's desktop renderer may
 * lack ffmpeg. A ~150-line codec removes that external dependency for stills.
 */

import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const crcTable = (() => {
  const table = new Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

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

/**
 * Decode to RGBA. Supports colorType 0 (gray), 2 (RGB), 6 (RGBA), bitDepth 8,
 * interlace 0. Anything else throws (the caller falls back to opaque).
 */
export const decodePng = (input) => {
  const bytes = Buffer.from(input)
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 6].includes(colorType)) {
    throw new Error(`unsupported PNG (depth=${bitDepth}, color=${colorType}, interlace=${interlace})`)
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    raw.copy(line, 0, pos, pos + stride)
    pos += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = value & 0xff
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels
      const dst = (y * width + x) * 4
      if (channels === 4) {
        rgba[dst] = line[src]
        rgba[dst + 1] = line[src + 1]
        rgba[dst + 2] = line[src + 2]
        rgba[dst + 3] = line[src + 3]
      } else if (channels === 3) {
        rgba[dst] = line[src]
        rgba[dst + 1] = line[src + 1]
        rgba[dst + 2] = line[src + 2]
        rgba[dst + 3] = 255
      } else {
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = line[src]
        rgba[dst + 3] = 255
      }
    }
    line.copy(prev)
  }
  return { width, height, rgba }
}

/** Encode RGBA to a PNG (filter 0, deflate). */
export const encodePng = (rgba, width, height) => {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
