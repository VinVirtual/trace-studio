// Writing outputs without following symbolic links: a link planted where an output will go could
// otherwise send a replay or a key-bearing file somewhere else. Each file is written to a temporary
// name in the same folder, then renamed over the target.
import { lstatSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Throws when `path` exists and is a symbolic link. */
export function refuseLink(path) {
  let st
  try { st = lstatSync(path) } catch (e) { if (e.code === 'ENOENT') return; throw e }
  if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link; refusing to write through it`)
}

/** A temporary path next to `path`, for a writer (such as ffmpeg) that will be renamed into place. */
export const tempNext = (path) => join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)

/** Rename a finished temporary file over `path`, refusing a link at `path`. */
export function moveInto(tmp, path) {
  refuseLink(path)
  renameSync(tmp, path)
  return path
}

/** Write `content` to `path` through a temporary file; never follows a link at `path`. */
export function safeWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  refuseLink(path)
  const tmp = tempNext(path)
  try { writeFileSync(tmp, content, { flag: 'wx' }); return moveInto(tmp, path) } catch (e) { rmSync(tmp, { force: true }); throw e }
}

/** Remove earlier outputs so a folder never mixes files from two runs. Links are refused, not followed. */
export function removeStale(paths) {
  for (const p of paths) { refuseLink(p); rmSync(p, { force: true }) }
}
