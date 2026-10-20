import {defineConfig, loadEnv} from 'vite'

// The node and origins this page reads are never built in (see .env.example).
// A build without them would ship a page that talks to nothing, so it stops
// here and says what to set.
function requireEnv(env: Record<string, string>, names: string[]) {
  const missing = names.filter((n) => !env[n])
  if (missing.length) {
    throw new Error(`${missing.join(', ')} not set: copy .env.example to .env, or set them in the environment`)
  }
}

// Every route lives in the hash and every asset path is relative, so the same
// build is served unchanged from a GitHub Pages project path, a custom
// domain's root, or a path on a gateway.
export default defineConfig(({mode}) => {
  requireEnv(loadEnv(mode, '..', 'VITE_'), ['VITE_ZVM_NODE', 'VITE_GATEWAY'])
  return {
    // One .env for the repository, beside the scripts that read it too.
    envDir: '..',
    base: './',
    server: {port: 47620, strictPort: true},
    preview: {port: 47621, strictPort: true},
  }
})
