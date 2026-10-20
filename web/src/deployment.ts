// The board's deployment record: deployments/<VITE_DEPLOYMENT, default zvm>.json,
// written by contracts/scripts/deploy.mjs and kept out of git, because every
// devnet deploys its own. Null when this build has none: boot.ts then shows
// that the board is not deployed instead of starting it.

export interface Deployment {
  chainId: number
  zchan: string
  startBlock: number
}

const records = import.meta.glob<Deployment>('../../deployments/*.json', {eager: true, import: 'default'})

export const record: Deployment | null = records[`../../deployments/${import.meta.env.VITE_DEPLOYMENT || 'zvm'}.json`] ?? null
