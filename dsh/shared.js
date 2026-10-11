// Shared helpers for the dsh-plugin-video-toolkit bundle entry.
//
// The plugin deliberately owns no video logic of its own: every operation is the
// packaged `video_ops.py` from the sibling `skill/` directory, run through a
// Python interpreter that this module resolves. Keeping one implementation is
// what makes the skill and the tools describe the same behaviour.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Hidden console window on Windows (node:child_process flags). */
const CREATE_NO_WINDOW = 0x08000000

/** The harness home: where DSH ships its Python and where per-user state belongs. */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Where a call's JSON result file is written.
 *
 * The system temp directory, because it is the one location that is writable under a
 * confined DSH file policy *and* under no policy at all: the workspace is not always
 * where the input lives, and the DSH home is refused outside it. Files are removed as
 * soon as the payload has been read.
 */
function resultDir() {
  const directory = join(tmpdir(), 'dsh-video-toolkit')
  mkdirSync(directory, { recursive: true })
  return directory
}

/**
 * Candidate Python interpreters, cheapest and most likely first.
 *
 * DSH ships its own Python under the harness home, which is the one the desktop
 * app guarantees; PATH is next; then the platform defaults.
 */
export function pythonCandidates() {
  const bundled = join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  const out = []
  if (process.env.DSH_PYTHON) out.push(process.env.DSH_PYTHON)
  out.push(bundled)
  if (process.platform === 'win32') {
    out.push('python.exe', 'python3.exe', 'py.exe')
  } else {
    out.push('python3', 'python')
  }
  return out
}

/** First candidate that exists on disk, or null when only PATH names remain. */
export function resolvePython() {
  for (const candidate of pythonCandidates()) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    } else {
      return candidate
    }
  }
  return 'python'
}

/**
 * Run the packaged video_ops.py and resolve with its parsed JSON payload.
 *
 * The child's stdio is *not* piped: DSH's confined file sandbox refuses to open the
 * named pipes a piped spawn needs (EPERM), so the payload travels through a file
 * instead — `--json-out` writes it, and this module reads it back. Nothing about that
 * is specific to a sandbox: a file is also immune to console code pages, which is what
 * silently mangles CJK output on a Chinese Windows.
 *
 * Resolves `{ ok: true, value }` on a parsed payload and `{ ok: false, error }`
 * otherwise, so a tool can always answer with a structured result instead of
 * throwing a stack trace into the transcript.
 */
export function runVideoOps({ scriptPath, args, cwd, timeoutMs = 15 * 60 * 1000 }) {
  const python = resolvePython()
  return runProcess(python, [scriptPath, ...args, '--json-out', join(resultDir(), `result-${randomUUID()}.json`)],
    { cwd, timeoutMs, parseResult: true })
}

/**
 * Spawn a process with file-backed stdio (never pipes) and collect what it produced.
 *
 * Both handlers below exist for one reason: a piped spawn is refused with EPERM under a
 * confined DSH sandbox, so stdout and stderr are redirected into files. That also keeps
 * CJK output intact on a Chinese Windows console code page.
 */
function runProcess(command, argv, { cwd, timeoutMs, parseResult }) {
  return new Promise((resolve) => {
    const scratch = resultDir()
    const stdoutFile = join(scratch, `stdout-${randomUUID()}.txt`)
    const stderrFile = join(scratch, `stderr-${randomUUID()}.txt`)
    let child
    try {
      child = spawn(command, argv, {
        cwd: cwd && existsSync(cwd) ? cwd : undefined,
        windowsHide: true,
        stdio: ['ignore', openSync(stdoutFile, 'w'), openSync(stderrFile, 'w')],
        creationFlags: process.platform === 'win32' ? CREATE_NO_WINDOW : 0,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      cleanup([stdoutFile, stderrFile])
      resolve({ ok: false, error: `cannot start ${command}: ${error}` })
      return
    }

    const readTail = (file, lines = 8) => {
      try {
        return readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n')
      } catch {
        return ''
      }
    }

    const done = (outcome) => {
      clearTimeout(timer)
      cleanup([stdoutFile, stderrFile])
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      done({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s`, stderr: readTail(stderrFile) })
    }, timeoutMs)

    child.on('error', (error) => done({ ok: false, error: `cannot start ${command}: ${error.message}` }))
    child.on('close', (code) => {
      const stderr = readTail(stderrFile)
      if (!parseResult) {
        done({ ok: code === 0, code, stdout: readTail(stdoutFile, 200), stderr })
        return
      }
      const resultFile = argv[argv.length - 1]
      let text = ''
      try {
        text = readFileSync(resultFile, 'utf8')
      } catch {
        done({
          ok: false,
          code,
          stderr,
          error: `video_ops produced no result file (exit ${code})${stderr ? `:\n${stderr}` : ''}`,
        })
        return
      }
      cleanup([resultFile])
      const start = text.indexOf('{')
      try {
        const parsed = JSON.parse(start >= 0 ? text.slice(start) : text)
        done({ ok: code === 0 && parsed.ok !== false, value: parsed, code, stderr })
      } catch (error) {
        done({ ok: false, code, stderr, error: `unparseable result file: ${error.message}` })
      }
    })
  })
}

function cleanup(files) {
  for (const file of files) {
    try {
      rmSync(file, { force: true })
    } catch { /* best effort */ }
  }
}

/** Absolute path of a result file, or null when the payload has none. */
export function firstFile(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.sheet === 'string') return payload.sheet
  if (typeof payload.out === 'string') return payload.out
  if (typeof payload.report === 'string') return payload.report
  if (Array.isArray(payload.frames)) {
    const hit = payload.frames.find((frame) => frame && typeof frame.file === 'string')
    if (hit) return hit.file
  }
  return null
}

/** Model-facing text for any payload: the JSON, prefixed by a one-line verdict. */
export function summarize(payload) {
  const lines = []
  if (payload && typeof payload === 'object') {
    if (payload.error) lines.push(`error: ${payload.error}`)
    if (payload.file) lines.push(`file: ${payload.file}`)
    if (typeof payload.duration_human === 'string') lines.push(`duration: ${payload.duration_human}`)
    if (payload.stream_count) {
      lines.push(`streams: ${payload.stream_count.video} video / ${payload.stream_count.audio} audio`)
    }
    if (payload.ok_count !== undefined) lines.push(`frames written: ${payload.ok_count}`)
    if (payload.sheet) lines.push(`sheet: ${payload.sheet}`)
    if (payload.out) lines.push(`output: ${payload.out}`)
    if (payload.out_size_human) lines.push(`size: ${payload.out_size_human}`)
    if (payload.report) lines.push(`report: ${payload.report}`)
    if (payload.encoder) lines.push(`encoder: ${payload.encoder}`)
    if (!lines.length && payload.ok !== undefined) {
      // `doctor` and friends answer with their own report shape.
      const found = payload.resolved ?? payload.found ?? {}
      lines.push(`video_ops doctor: ${payload.ok ? 'ok' : 'not ok'}`)
      if (found.ffmpeg || found.ffprobe) lines.push(`ffmpeg: ${found.ffmpeg ?? 'missing'}`)
      for (const warning of payload.warnings ?? []) lines.push(`warning: ${warning}`)
    }
  }
  return lines.length ? lines.join('\n') : 'no summary'
}
