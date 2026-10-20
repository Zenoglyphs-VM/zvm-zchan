/// <reference types="vite/client" />

interface ImportMetaEnv {
  // A ZVM node's base URL, its JSON-RPC at /rpc (see .env.example).
  readonly VITE_ZVM_NODE: string
  // Where the explorer, Glyphswap and the other apps are.
  readonly VITE_GATEWAY: string
}
