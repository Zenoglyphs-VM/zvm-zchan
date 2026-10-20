// A small element builder. Everything a poster wrote reaches the page as text
// nodes through here, never as HTML.
type Child = Node | string | number | null | undefined | false
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, String(v))
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : String(c))
  }
  return el
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T

// infoTip is an (i) beside a heading whose text shows on hover, and on tap or
// keyboard focus, which is where a heading's explanation goes rather than a
// grey line under it.
export function infoTip(text: string) {
  return h(
    'button',
    {class: 'info-tip', type: 'button', 'aria-label': text, 'data-tip': text},
    h('span', {'aria-hidden': 'true'}, 'i'),
  )
}
