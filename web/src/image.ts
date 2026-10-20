// Images, on the way in and on the way out.
//
// On the way in, everything but a small GIF is decoded and drawn again in the
// browser before it is posted. That is what strips metadata: a phone photo's
// EXIF carries where it was taken, and a post is on the chain for good. It is
// also how a photo gets under the contract's 64 KiB, as WebP where the browser
// can write it and JPEG where it cannot.
//
// On the way out, a post's bytes are shown only as one of four raster formats,
// recognised by their first bytes.
import {IMAGE_EDGE, IMAGE_TARGET, MAX_IMAGE} from './config'

export interface ImageKind {
  mime: string
  ext: string
}

const KINDS: [number[], ImageKind][] = [
  [[0xff, 0xd8, 0xff], {mime: 'image/jpeg', ext: 'jpg'}],
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], {mime: 'image/png', ext: 'png'}],
  [[0x47, 0x49, 0x46, 0x38], {mime: 'image/gif', ext: 'gif'}],
]

export function sniff(b: Uint8Array): ImageKind | null {
  for (const [magic, kind] of KINDS) if (magic.every((v, i) => b[i] === v)) return kind
  // RIFF....WEBP
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP')
    return {mime: 'image/webp', ext: 'webp'}
  return null
}

export interface Prepared {
  bytes: Uint8Array
  kind: ImageKind
  width: number
  height: number
  from: number // the file's own size, for "from 2.3 MB"
  url: string // a preview
  kept: boolean // posted as it was, not re-encoded
}

async function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((r) => canvas.toBlob(r, type, quality))
}

export async function prepare(file: File): Promise<Prepared> {
  const raw = new Uint8Array(await file.arrayBuffer())
  const kind = sniff(raw)
  if (!kind) throw new Error('Not a JPEG, PNG, GIF or WebP image.')
  // createImageBitmap applies the EXIF orientation, so a rotated phone photo
  // is drawn the way it was taken.
  const bitmap = await createImageBitmap(new Blob([raw], {type: kind.mime}), {imageOrientation: 'from-image'} as any).catch(() => {
    throw new Error('This image could not be read.')
  })
  const {width, height} = bitmap

  // A GIF small enough is posted as it is, to keep its animation.
  if (kind.ext === 'gif' && raw.length <= MAX_IMAGE) {
    bitmap.close()
    return {bytes: raw, kind, width, height, from: raw.length, url: URL.createObjectURL(file), kept: true}
  }

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  let scale = Math.min(1, IMAGE_EDGE / Math.max(width, height))
  for (let round = 0; round < 12; round++) {
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (const q of [0.82, 0.7, 0.58, 0.46]) {
      let blob = await encode(canvas, 'image/webp', q)
      // A browser that cannot write WebP hands back a PNG instead.
      if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', q)
      if (blob && blob.size <= IMAGE_TARGET) {
        bitmap.close()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        return {
          bytes,
          kind: sniff(bytes)!,
          width: canvas.width,
          height: canvas.height,
          from: raw.length,
          url: URL.createObjectURL(blob),
          kept: false,
        }
      }
    }
    scale *= 0.75
  }
  bitmap.close()
  throw new Error('This image would not fit in 48 KiB.')
}

export function size(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
