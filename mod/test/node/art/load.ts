/** Test helper: reads mod/art/<agent>.json from disk (Node only; the mod itself never imports art files). */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeArt, type Art } from '../../../src/art/art.ts'

export const ART_DIR = fileURLToPath(new URL('../../../art/', import.meta.url).href)
export const AGENTS = ['zealot', 'builder', 'scout', 'inquisitor', 'scribe', 'archivist', 'sentinel', 'forgemaster', 'exorcist', 'preceptor', 'herald', 'assayer', 'sculptor']
export const artFiles = (): string[] => readdirSync(ART_DIR).filter(f => f.endsWith('.json'))
export const rawArt = (agent: string): unknown => JSON.parse(readFileSync(`${ART_DIR}${agent}.json`, 'utf8'))
export const loadArt = (agent: string): Art => decodeArt(rawArt(agent))
