# dsh-plugin-video-toolkit

A **DeepSeek Harness plugin** (a profile bundle) that gives the agent real video and audio
capability: it mounts the `video-toolkit` skill *and* registers three tools backed by ffmpeg.

> The sibling repository [dsh-video-skill](https://github.com/Alnyzzz/dsh-video-skill) ships the
> same toolkit as a plain **skill folder**. This repository is the **plugin** form: it appears in
> DSH's Plugins page, installs from the "Add plugin" dialog, and adds tools the model can call
> directly, so every video call gets its own card in the conversation instead of showing up as a
> generic terminal command.

## What it adds

| Surface | Name | What it does |
| --- | --- | --- |
| Skill | `video-toolkit` | The playbook: probe → look at frames → act → verify. Shows up as `/video-toolkit`. |
| Tool | `video_ops` | Metadata and non-destructive checks: `probe`, `doctor`, `scenes`, `silence`, `loudness`. |
| Tool | `video_frames` | Stills and timestamp-labelled contact sheets, so the model can actually see the picture. |
| Tool | `video_edit` | `clip`, `compress`, `convert`, `scale`, `gif`, `audio`, `normalize`, `report`. |

Everything is one implementation: the tools wrap `skill/scripts/video_ops.py` from this package,
so the skill's instructions and the tools can never drift apart. Each tool returns the same JSON
payload the CLI prints, plus a one-line summary.

## Install

### From the DSH app (recommended)

1. Open DSH → sidebar → **Plugins** → **Add plugin**.
2. Paste the package path (a clone of this repository works directly):
   `C:\path\to\dsh-plugin-video-toolkit`
   or the Git address `https://github.com/Alnyzzz/dsh-plugin-video-toolkit`.
3. Choose the registry/source you normally use and press **安装 / Install**. A local path needs no
   registry.

Installing enables the bundle by default; DSH recomposes and mounts it in the running session.

### From the CLI

```powershell
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "<path-or-git-url>"
```

`dsh plugin --profile <name> add <spec>` is the same operation the dialog performs, and it needs
write access to `%DSH_HOME%\profiles\<name>` (the app does this outside any workspace sandbox).

### Verify

Ask the agent to run the `video_ops` tool with `op: "doctor"`, or check the Plugins page: the entry
reads **video-toolkit** and shows the three tools under it. The plugin logs `mounted skill
video-toolkit and tools video_ops, video_frames, video_edit` on load.

Offline self-test (loads the entry, calls every tool, validates each result against the tool's own
output schema):

```bash
node scripts/selftest.mjs "/path/to/sample.mp4"
```

Two sandbox facts are baked into the code and easy to reintroduce by accident, so the self-test
covers both: the child's stdio is file-backed (a piped `spawn` is refused with `EPERM` under a
confined DSH file policy), and the declared output schema must not require a field a call cannot
produce.

## Reloading after an edit

DSH imports a plugin module when it composes the profile; HMR watches the profile manifest and
patch layers, not the inside of an installed package. After editing `dsh/` or `skill/`, either
restart DSH or toggle the bundle off and on in the Plugins page.

## ffmpeg

The plugin does not bundle ffmpeg (that would mean a 30–100 MB binary in the package). It finds one
the way the skill does:

- `video_ops` with `op: "doctor"` reports what was found and where;
- `op: "doctor"` with `bootstrap: true, download: true` installs a private, verified pair into
  `%DSH_HOME%\video\tools`;
- or point it at an existing build with `DSH_FFMPEG_DIR` / `DSH_FFMPEG_FFMPEG`.

## Layout

```
dsh-plugin-video-toolkit/
├── package.json              # main → dsh/index.js, dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml          # inserts the `video-toolkit` row into the profile composition
├── dsh/
│   ├── index.js              # skill + tool registration
│   └── shared.js             # python resolution, subprocess runner, summaries
└── skill/                    # the payload the skill and tools both use
    ├── SKILL.md
    ├── SKILL.zh-CN.md
    ├── references/
    └── scripts/{video_ops.py,video_common.py}
```

The plugin is plain ESM with **no dependencies and no build step**, so a clone is a working
package. It imports only `node:` builtins.

## How it registers

```js
export const inject = ['skills', 'tools']

export function apply(ctx) {
  ctx.tools.register(videoOpsTool)     // three tools, registered independently
  ctx.skills.register({ name: 'video-toolkit', description, content, path, resourceBase })
}
```

Failures are contained: if a tool or the skill cannot register, it logs one line and the rest of
the plugin still mounts. Disposing the plugin's fiber (disable, remove, reload) unregisters both,
because registration rides a Cordis effect on the calling context.

## Requirements

- DSH 0.2.0-rc.2 or later (the version this was developed and verified against).
- Python 3.9+ — DSH's bundled interpreter is used automatically
  (`%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`), and `DSH_PYTHON`
  overrides it.
- ffmpeg + ffprobe, as described above.

## Sandbox notes

DSH's `workspace-write` file policy denies writes outside the workspace, and the system temp
directory is outside it. The toolkit therefore keeps all scratch data inside the workspace or the
private `%DSH_HOME%\video` directory (see `work_dir()` in `skill/scripts/video_common.py`), and
`tempfile.mkdtemp` is deliberately avoided: its 0700 mode is refused by the sandbox ACL, which used
to turn a successful contact sheet into a `PermissionError`.

## License

MIT — see [LICENSE](LICENSE). ffmpeg builds downloaded by `bootstrap` keep their own licences.

Author: **Alnyzzz**
