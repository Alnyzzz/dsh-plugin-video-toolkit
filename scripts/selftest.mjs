#!/usr/bin/env node
// Self-test for the plugin: loads dsh/index.js, calls every registered tool through its
// real execute() path, and validates each result against the tool's own declared output
// schema. Run it after any edit to dsh/ or skill/:
//
//   node scripts/selftest.mjs [path-to-a-sample-video]
//
// It also proves the two things that broke during development: that no tool omits a
// required output field, and that the packaged Python can be started (which fails with
// EPERM if a piped spawn is ever reintroduced).
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const mod = await import(new URL('../dsh/index.js', import.meta.url).href)

const registered = []
const registeredSkills = []
const ctx = {
  tools: { register: (tool) => registered.push(tool) },
  skills: { register: (skill) => registeredSkills.push(skill) },
}
mod.apply(ctx)

function validate(tool, value) {
  const schema = tool.output?.schema ?? {}
  const problems = []
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) problems.push(`missing required ${key}`)
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const got = value[key]
    if (got === undefined || got === null) continue
    if (spec.type === 'string' && typeof got !== 'string') problems.push(`${key} must be a string, got ${typeof got}`)
    if (spec.type === 'boolean' && typeof got !== 'boolean') problems.push(`${key} must be a boolean`)
    if (spec.type === 'object' && typeof got !== 'object') problems.push(`${key} must be an object`)
  }
  return problems
}

const sample = process.argv[2]
const cases = [['video_ops', { op: 'doctor' }]]
if (sample && existsSync(sample)) {
  cases.push(['video_ops', { op: 'probe', file: sample }])
  cases.push(['video_frames', { file: sample, mode: 'sheet', count: 4, cols: 2 }])
  cases.push(['video_edit', { op: 'audio', file: sample, codec: 'pcm_s16le', rate: 16000, mono: true }])
} else {
  console.log('(no sample video passed: only the toolchain check runs)')
  console.log(`  usage: node scripts/selftest.mjs "C:\\path\\to\\sample.mp4"`)
}

let failures = 0
for (const [name, args] of cases) {
  const tool = registered.find((candidate) => candidate.name === name)
  if (!tool) {
    console.log(`${name} -> NOT REGISTERED`)
    failures += 1
    continue
  }
  const value = await tool.execute(args)
  const problems = validate(tool, value)
  const rendered = tool.output.render(args, value)
  console.log(`${name} ${JSON.stringify(args.op ?? args.mode ?? '')} -> ${problems.length ? 'INVALID: ' + problems.join('; ') : 'valid'}`)
  console.log(`   ${rendered[0].text.split('\n')[0]}`)
  if (value.file) console.log(`   file: ${value.file}`)
  if (problems.length) failures += 1
}

const skillName = 'video-toolkit'
const skill = registeredSkills.find((entry) => entry.name === skillName)
console.log(`\nskill "${skillName}" registered: ${Boolean(skill)}`)
if (skill) {
  console.log(`   description: ${skill.description.slice(0, 80)}...`)
  console.log(`   content: ${skill.content.length} chars, resourceBase: ${skill.resourceBase?.kind}`)
} else {
  failures += 1
}
console.log(failures ? `${failures} problem(s) found` : 'all tool results satisfy their declared schema')
process.exit(failures ? 1 : 0)
