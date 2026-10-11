// DeepSeek Harness (DSH) plugin: video-toolkit.
//
// Installed as a profile bundle (see ../cordis.patch.yml), this entry does two
// things through the services DSH exposes to plugins:
//
//   1. `ctx.skills.register(...)` mounts the `video-toolkit` playbook, so the
//      model gets the workflow guidance the same way a filesystem skill would
//      provide it (probe -> look at frames -> act -> verify).
//   2. `ctx.tools.register(...)` adds three tools that wrap the packaged
//      `skill/scripts/video_ops.py`: metadata, frames/contact sheets, and the
//      editing jobs. Tools give every call a real card in the transcript and a
//      stable output contract, which a bare terminal invocation cannot.
//
// Everything degrades loudly but locally: a failure to register one thing never
// takes the plugin's host scope down.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { firstFile, resolvePython, runVideoOps, summarize } from './shared.js'

const SKILL_FILE_URL = new URL('../skill/SKILL.md', import.meta.url)
const SKILL_DIR = fileURLToPath(new URL('../skill/', import.meta.url))
const SCRIPT_PATH = fileURLToPath(new URL('../skill/scripts/video_ops.py', import.meta.url))

export const name = 'video-toolkit'
export const inject = ['skills', 'tools']

export const SKILL_NAME = 'video-toolkit'
export const OPS_TOOL_NAME = 'video_ops'
export const FRAMES_TOOL_NAME = 'video_frames'
export const EDIT_TOOL_NAME = 'video_edit'

/**
 * Split SKILL.md into { description, body }. The runtime registry takes the body
 * verbatim — frontmatter is only parsed by the filesystem provider — so the
 * `---` block comes off here and the description travels as its own field.
 */
export function parseSkillMarkdown(raw) {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!frontmatter) throw new Error('SKILL.md has no frontmatter block')
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!description) throw new Error('SKILL.md frontmatter has no description field')
  const body = raw.slice(frontmatter[0].length).trim()
  if (body === '') throw new Error('SKILL.md has an empty body')
  return { description, body }
}

/**
 * The DSH-specific preamble prepended to the skill body: inside the plugin the
 * script lives in the package, and Python may not be named `python`.
 */
export function runtimePreamble(scriptPath) {
  return [
    '## DSH runtime note (injected by the video-toolkit plugin)',
    '',
    'This skill is mounted by a DSH plugin, so its script lives inside that installed package:',
    '',
    '```bash',
    `python "${scriptPath}" <command> [args]`,
    '```',
    '',
    `Use the resolved interpreter \`${resolvePython()}\` when \`python\` is not on PATH.`,
    'Prefer the plugin tools (`video_ops`, `video_frames`, `video_edit`) over calling the script directly:',
    'they return the same JSON, run without shell quoting problems, and appear as cards in the conversation.',
  ].join('\n')
}

/** JSON schema fragment shared by every tool: the input file. */
const INPUT_PROPERTY = {
  type: 'string',
  description: 'Path to the video or audio file. Quote-free; the tool passes it as an argument.',
}

/** Build a tool whose body is a single video_ops.py invocation. */
function makeTool({ name: toolName, description, parameters, buildArgs, timeoutMs }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      // `file` is deliberately absent from the schema: the declared output schema is
      // validated strictly, and a command like `doctor` or `probe` produces no new file.
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          result: { type: 'object', additionalProperties: true },
        },
        required: ['ok', 'summary'],
        additionalProperties: true,
      },
      render(_args, value) {
        const parts = [value.summary]
        if (value.file) parts.push(`file: ${value.file}`)
        parts.push('', JSON.stringify(value.result, null, 2))
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const input = String(args.file ?? '')
      const built = buildArgs(args)
      const outcome = await runVideoOps({
        scriptPath: SCRIPT_PATH,
        args: built,
        cwd: args.cwd,
        timeoutMs,
      })
      const payload = outcome.value ?? { ok: false, error: outcome.error }
      // `file` is omitted rather than set to null: the declared output schema types it
      // as a string, and a null fails validation before the card ever renders.
      const result = { ok: outcome.ok, summary: summarize(payload), result: payload }
      const produced = firstFile(payload)
      if (produced) result.file = produced
      if (!outcome.ok && payload.error) result.summary = `error: ${payload.error}`
      return result
    },
    timeoutMs,
  }
}

/**
 * Tool registration. Each tool is registered independently so one rejection
 * (an older DSH that validates schemas differently, a name collision) cannot
 * cost the others or the skill.
 */
export function registerTools(ctx) {
  const registered = []

  const opsTool = makeTool({
    name: OPS_TOOL_NAME,
    description:
      'Inspect a video or audio file (metadata) or run the non-destructive checks: probe, doctor, ' +
      'scenes, silence, loudness. Returns the JSON payload plus a one-line summary. ' +
      'Use op=probe first for any video task; use video_frames to actually look at the picture.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['probe', 'doctor', 'scenes', 'silence', 'loudness'],
          description: 'probe = metadata; doctor = ffmpeg/ffprobe toolchain check; scenes = shot boundaries; ' +
            'silence = silent stretches and speech windows; loudness = EBU R128 loudness.',
        },
        file: {
          type: 'string',
          description: 'Input file. Required for every op except doctor.',
        },
        cwd: { type: 'string', description: 'Working directory for relative output paths.' },
        threshold: { type: 'number', description: 'op=scenes: scene-change score 0..1, default 0.35.' },
        noise_db: { type: 'number', description: 'op=silence: noise floor in dB, default -35.' },
        min_duration: { type: 'number', description: 'op=silence: minimum silence length in seconds, default 0.6.' },
        ebur128: { type: 'boolean', description: 'op=loudness: measure EBU R128 instead of volumedetect.' },
        rescan: { type: 'boolean', description: 'Re-walk the disks for ffmpeg instead of the cached candidate list.' },
        bootstrap: { type: 'boolean', description: 'Install a private ffmpeg automatically when none is usable.' },
        download: { type: 'boolean', description: 'Allow that installation to download ffmpeg (~30-100 MB).' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    buildArgs(args) {
      const op = String(args.op)
      const flags = []
      if (args.rescan) flags.push('--rescan')
      if (args.bootstrap) flags.push('--bootstrap')
      if (args.download) flags.push('--download')
      if (op === 'doctor') return ['doctor', ...flags]
      const out = [op, String(args.file)]
      if (op === 'scenes' && args.threshold !== undefined) out.push('--threshold', String(args.threshold))
      if (op === 'silence' && args.noise_db !== undefined) out.push('--noise-db', String(args.noise_db))
      if (op === 'silence' && args.min_duration !== undefined) out.push('--min-duration', String(args.min_duration))
      if (op === 'loudness' && args.ebur128) out.push('--ebur128')
      return [...out, ...flags]
    },
    timeoutMs: 20 * 60 * 1000,
  })

  const framesTool = makeTool({
    name: FRAMES_TOOL_NAME,
    description:
      'Extract stills from a video so the model can actually see the picture, or build one ' +
      'timestamp-labelled contact sheet. Use mode=sheet for "what is in this video"; use mode=frames ' +
      'with at/count/every for specific moments. Read the returned image path with the read_image tool.',
    parameters: {
      type: 'object',
      properties: {
        file: INPUT_PROPERTY,
        mode: {
          type: 'string',
          enum: ['sheet', 'frames'],
          description: 'sheet = one labelled grid image (default); frames = individual stills.',
        },
        at: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact timestamps, e.g. ["00:01:10", "45.5"]. mode=frames only.',
        },
        count: { type: 'number', description: 'Evenly spaced sample count (sheet default 12, frames default 1).' },
        every: { type: 'string', description: 'Sample every N seconds instead of count.' },
        cols: { type: 'number', description: 'mode=sheet: grid columns, default 4.' },
        rows: { type: 'number', description: 'mode=sheet: grid rows (overrides count).' },
        width: { type: 'number', description: 'Still width in pixels, aspect preserved (default 960, sheet cells 480).' },
        outdir: { type: 'string', description: 'Output directory (mode=frames). Default: <input>_frames.' },
        out: { type: 'string', description: 'Output image path (mode=sheet). Default: <input>_sheet.jpg.' },
        format: { type: 'string', enum: ['jpeg', 'png', 'webp'], description: 'Still format, default jpeg.' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    buildArgs(args) {
      const mode = String(args.mode ?? 'sheet')
      if (mode === 'sheet') {
        const out = ['sheet', String(args.file)]
        if (args.count !== undefined) out.push('--count', String(args.count))
        if (args.cols !== undefined) out.push('--cols', String(args.cols))
        if (args.rows !== undefined) out.push('--rows', String(args.rows))
        if (args.out) out.push('--out', String(args.out))
        if (args.width !== undefined) out.push('--cell-width', String(args.width))
        return out
      }
      const out = ['frames', String(args.file)]
      for (const stamp of args.at ?? []) out.push('--at', String(stamp))
      if (args.count !== undefined) out.push('--count', String(args.count))
      if (args.every) out.push('--every', String(args.every))
      if (args.width !== undefined) out.push('--width', String(args.width))
      if (args.outdir) out.push('--outdir', String(args.outdir))
      if (args.format) out.push('--format', String(args.format))
      return out
    },
    timeoutMs: 20 * 60 * 1000,
  })

  const editTool = makeTool({
    name: EDIT_TOOL_NAME,
    description:
      'Produce a new media file: cut a clip, compress to a size budget, convert the container, resize, ' +
      'make an animated GIF, extract or normalise the audio, or write an inspection report. ' +
      'Returns the absolute output path, its size and the encoder that was actually used.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['clip', 'compress', 'convert', 'scale', 'gif', 'audio', 'normalize', 'report'],
          description: 'The job to run.',
        },
        file: INPUT_PROPERTY,
        out: { type: 'string', description: 'Output path (or directory). Defaults beside the input.' },
        start: { type: 'string', description: 'op=clip|gif: start timestamp ("00:01:10" or seconds).' },
        end: { type: 'string', description: 'op=clip: end timestamp.' },
        duration: { type: 'string', description: 'op=clip|gif: length in seconds instead of --end.' },
        copy: { type: 'boolean', description: 'op=clip: stream copy (lossless, fast, keyframe-aligned).' },
        crf: { type: 'number', description: 'Quality for re-encodes: lower is better/larger. Default 20 (compress 26).' },
        preset: { type: 'string', description: 'Encoder preset, e.g. medium / slow / ultrafast.' },
        target_mb: { type: 'number', description: 'op=compress: aim for this many megabytes.' },
        max_width: { type: 'number', description: 'op=compress|convert: downscale so width <= N.' },
        to: { type: 'string', description: 'op=convert: target extension, e.g. mp4 / mkv / webm.' },
        size: { type: 'string', description: 'op=scale: 1280x720, 1920:-2 or 720p/1080p/4k.' },
        fit: { type: 'string', enum: ['stretch', 'pad', 'crop'], description: 'op=scale: how to match the aspect ratio.' },
        width: { type: 'number', description: 'op=gif: pixel width (default 640).' },
        fps: { type: 'number', description: 'op=gif: frames per second (default 12).' },
        codec: { type: 'string', description: 'op=audio|normalize: aac / libmp3lame / pcm_s16le / libopus / flac / copy.' },
        bitrate: { type: 'string', description: 'op=audio|normalize: audio bitrate, e.g. 192k.' },
        rate: { type: 'number', description: 'op=audio: sample rate, e.g. 16000.' },
        mono: { type: 'boolean', description: 'op=audio: downmix to one channel.' },
        lufs: { type: 'number', description: 'op=normalize: target loudness in LUFS (default -16).' },
        cols: { type: 'number', description: 'op=report: contact-sheet columns.' },
        count: { type: 'number', description: 'op=report: contact-sheet cells.' },
      },
      required: ['op', 'file'],
      additionalProperties: false,
    },
    buildArgs(args) {
      const op = String(args.op)
      const out = [op, String(args.file)]
      const push = (flag, value) => { if (value !== undefined && value !== null) out.push(flag, String(value)) }
      push('--out', args.out)
      if (op === 'clip') {
        push('--start', args.start)
        push('--end', args.end)
        push('--duration', args.duration)
        if (args.copy) out.push('--copy')
        push('--crf', args.crf)
        push('--preset', args.preset)
      } else if (op === 'compress') {
        push('--crf', args.crf)
        push('--preset', args.preset)
        push('--target-mb', args.target_mb)
        push('--max-width', args.max_width)
      } else if (op === 'convert') {
        push('--to', args.to ?? 'mp4')
        push('--crf', args.crf)
        push('--max-width', args.max_width)
      } else if (op === 'scale') {
        push('--size', args.size ?? '1280x720')
        push('--fit', args.fit)
        push('--crf', args.crf)
      } else if (op === 'gif') {
        push('--start', args.start)
        push('--duration', args.duration)
        push('--width', args.width)
        push('--fps', args.fps)
      } else if (op === 'audio') {
        push('--codec', args.codec)
        push('--bitrate', args.bitrate)
        push('--rate', args.rate)
        if (args.mono) out.push('--mono')
      } else if (op === 'normalize') {
        push('--lufs', args.lufs)
        push('--codec', args.codec)
        push('--bitrate', args.bitrate)
      } else if (op === 'report') {
        push('--cols', args.cols)
        push('--count', args.count)
      }
      return out
    },
    timeoutMs: 60 * 60 * 1000,
  })

  for (const tool of [opsTool, framesTool, editTool]) {
    try {
      ctx.tools.register(tool)
      registered.push(tool.name)
    } catch (error) {
      console.error(`[video-toolkit] tool ${tool.name} registration skipped: ${error}`)
    }
  }
  return registered
}

export function apply(ctx) {
  const tools = registerTools(ctx)

  let skill
  try {
    skill = parseSkillMarkdown(readFileSync(SKILL_FILE_URL, 'utf8'))
  } catch (error) {
    console.error(`[video-toolkit] skill registration skipped (cannot read ${SKILL_DIR}): ${error}`)
    return
  }

  try {
    // The disposer is unused on purpose: register() rides a Cordis effect on this
    // context, so disposing the plugin's fiber (remove / reload) unregisters it.
    ctx.skills.register({
      name: SKILL_NAME,
      description: skill.description,
      source: 'bundled',
      content: `${runtimePreamble(SCRIPT_PATH)}\n\n${skill.body}`,
      path: fileURLToPath(SKILL_FILE_URL),
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    })
  } catch (error) {
    console.error(`[video-toolkit] skill registration skipped: ${error}`)
  }

  console.log(`[video-toolkit] mounted skill ${SKILL_NAME} and tools ${tools.join(', ')}`)
}
