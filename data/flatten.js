#!/usr/bin/env node

/**
 * Pre-flatten a JSON-LD dataset so the browser can skip the expensive
 * `jsonld.flatten()` step at load time.
 *
 * Usage:
 *   node data/flatten.js <input.jsonld> [output.json]
 *
 * If no output path is given the result is written next to the input file
 * with a `-flat.json` suffix (e.g. esco.jsonld → esco-flat.json).
 *
 * The script prints progress information to stderr so you can monitor
 * long-running jobs.
 */

import { readFile, writeFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import jsonld from 'jsonld'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const elapsed = (startMs) => {
  const seconds = (performance.now() - startMs) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds - minutes * 60
  return `${minutes}m ${remainingSeconds.toFixed(1)}s`
}

const log = (message) => process.stderr.write(`${message}\n`)

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

const [inputPath, outputPath] = process.argv.slice(2)

if (!inputPath) {
  log('Usage: node data/flatten.js <input.jsonld> [output.json]')
  log('')
  log('Pre-flattens a JSON-LD file so the browser can load it instantly.')
  process.exit(1)
}

const resolvedInput = resolve(inputPath)

const resolvedOutput = outputPath
  ? resolve(outputPath)
  : join(dirname(resolvedInput), `${basename(resolvedInput, extname(resolvedInput))}-flat.json`)

/* --- 1. Read -------------------------------------------------------- */

log(`\n📂  Input:  ${resolvedInput}`)
log(`📄  Output: ${resolvedOutput}\n`)

const t0 = performance.now()
log('⏳  Reading input file...')

const inputStat = await stat(resolvedInput)
log(`    File size: ${formatBytes(inputStat.size)}`)

const raw = await readFile(resolvedInput, 'utf-8')
log(`✅  File read in ${elapsed(t0)}`)

/* --- 2. Parse JSON -------------------------------------------------- */

const t1 = performance.now()
log('\n⏳  Parsing JSON...')

const parsed = JSON.parse(raw)

const topLevelEntries = Array.isArray(parsed)
  ? parsed.length
  : typeof parsed === 'object' && parsed !== null
    ? Object.keys(parsed).length
    : 0

log(`✅  Parsed in ${elapsed(t1)} — ${topLevelEntries.toLocaleString()} top-level entries`)

/* --- 3. Flatten JSON-LD --------------------------------------------- */

const t2 = performance.now()
log('\n⏳  Flattening JSON-LD (this is the slow step)...')

// Log a heartbeat so the user knows the process is alive
const heartbeat = setInterval(() => {
  const mem = process.memoryUsage()
  log(
    `    … still flattening — elapsed ${elapsed(t2)}, ` +
      `heap ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}, ` +
      `rss ${formatBytes(mem.rss)}`,
  )
}, 5_000)

let flattened
try {
  flattened = await jsonld.flatten(parsed)
} catch (error) {
  clearInterval(heartbeat)
  const message = error instanceof Error ? error.message : String(error)
  log(`\n❌  jsonld.flatten() failed after ${elapsed(t2)}: ${message}\n`)
  process.exit(1)
} finally {
  clearInterval(heartbeat)
}

const flatCount = Array.isArray(flattened) ? flattened.length : 0
log(`✅  Flattened in ${elapsed(t2)} — ${flatCount.toLocaleString()} entities in the flat graph`)

/* --- 4. Write output ------------------------------------------------ */

const t3 = performance.now()
log('\n⏳  Serializing and writing output...')

const output = JSON.stringify(flattened)
await writeFile(resolvedOutput, output, 'utf-8')

const outputStat = await stat(resolvedOutput)
log(`✅  Written in ${elapsed(t3)} — ${formatBytes(outputStat.size)}`)

/* --- Done ----------------------------------------------------------- */

log(`\n🎉  All done in ${elapsed(t0)}`)
log(`    Input:  ${formatBytes(inputStat.size)} → Output: ${formatBytes(outputStat.size)}`)
log(`    Entities: ${flatCount.toLocaleString()}\n`)
log('Load the output file directly in the app to skip the flatten step.\n')
