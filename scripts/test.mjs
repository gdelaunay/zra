// npm test : les tests des trois briques, en français (textes de référence, ceux des assertions), puis la
// complétude des traductions (i18n-test.mjs).
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ZRA_LANG: 'fr' } }).status
const tests = run(['--no-warnings', '--test', 'zra-client/test/*.test.mjs', 'zra-daemon/test/*.test.mjs', 'zra-shim/test/*.test.mjs'])
const i18n = run(['scripts/i18n-test.mjs'])
process.exitCode = tests || i18n ? 1 : 0
