// Writes the board's two keys, the owner's and its first janitor's, and
// refuses to replace them. The owner can appoint more janitors later.
//
//   node scripts/keys.mjs [-out secrets/zchan.json], relative to the repository root
//
// Neither may be derived from anything public, unlike zvm's devnet keys: the
// owner takes the handle fees and appoints the janitor, and the janitor can
// hide any post from the page.
import {mkdirSync, writeFileSync} from 'node:fs'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {flag, root} from './lib.mjs'

const out = new URL(flag('out', 'secrets/zchan.json'), root)
mkdirSync(new URL('.', out), {recursive: true})
const keys = {
  owner: generatePrivateKey(),
  janitor: generatePrivateKey(),
}
try {
  writeFileSync(out, JSON.stringify(keys, null, 2) + '\n', {flag: 'wx', mode: 0o600})
} catch (e) {
  if (e.code === 'EEXIST') {
    console.error(`${out.pathname} exists; not replacing the board's keys`)
    process.exit(1)
  }
  throw e
}
console.log(`wrote ${out.pathname}`)
for (const [role, key] of Object.entries(keys)) console.log(`  ${role.padEnd(8)} ${privateKeyToAccount(key).address}`)
