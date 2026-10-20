// The page's entry: the board starts only when this build has its deployment
// record (deployment.ts), and otherwise says it is not deployed.
import {record} from './deployment'

if (record) {
  import('./main')
} else {
  const p = document.createElement('p')
  p.className = 'not-deployed'
  p.textContent = 'Not deployed on this chain.'
  document.body.append(p)
}
