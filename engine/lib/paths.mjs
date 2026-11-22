import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SKILL = resolve(ENGINE, '..')
