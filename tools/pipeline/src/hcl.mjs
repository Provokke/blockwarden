// Just enough HCL reading to find variable blocks and their top-level attributes. Strings, templates, heredocs
// and comments are masked first, so a brace or a quote inside one never moves a block's boundary.

// The text with every comment and the inside of every string and heredoc replaced by spaces. Newlines are kept,
// so an offset or a line number in the mask is the same in the text.
export function mask(text) {
  const out = text.split('')
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }

  // from just after an opening quote to just after its closing quote
  function endOfString(from) {
    let k = from
    while (k < text.length) {
      const c = text[k]
      if (c === '\\') k += 2
      else if (c === '"') return k + 1
      else if ((c === '$' || c === '%') && text[k + 1] === c && text[k + 2] === '{') k += 3
      else if ((c === '$' || c === '%') && text[k + 1] === '{') k = endOfTemplate(k + 2)
      else if (c === '\n') return k
      else k++
    }
    return k
  }

  // from just after ${ to just after its closing brace
  function endOfTemplate(from) {
    let depth = 1
    let k = from
    while (k < text.length && depth > 0) {
      const c = text[k]
      if (c === '"') {
        k = endOfString(k + 1)
        continue
      }
      if (c === '{') depth++
      else if (c === '}') depth--
      k++
    }
    return k
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '"') {
      const end = endOfString(i + 1)
      blank(i + 1, end - 1)
      i = end
    } else if (c === '#' || (c === '/' && next === '/')) {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      blank(i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      blank(i, stop)
      i = stop
    } else if (c === '<' && next === '<') {
      const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(text.slice(i))
      if (heredoc === null) {
        i += 2
        continue
      }
      const bodyStart = i + heredoc[0].length
      const terminator = new RegExp(`^[ \\t]*${heredoc[1]}[ \\t]*$`, 'm')
      const found = terminator.exec(text.slice(bodyStart))
      const stop = found === null ? text.length : bodyStart + found.index
      blank(bodyStart, stop)
      i = stop + (found === null ? 0 : found[0].length)
    } else {
      i++
    }
  }
  return out.join('')
}

// offset of the brace that closes the one at `open`, in masked text
function closingBrace(masked, open) {
  let depth = 0
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === '{') depth++
    else if (masked[k] === '}' && --depth === 0) return k
  }
  return -1
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length

// the part of a block's masked body at nesting depth zero, with everything nested blanked
function topLevel(maskedBody) {
  let depth = 0
  let out = ''
  for (const c of maskedBody) {
    if (c === '{' || c === '(' || c === '[') depth++
    if (depth === 0 || c === '\n') out += c
    else out += ' '
    if (c === '}' || c === ')' || c === ']') depth--
  }
  return out
}

// the expression assigned to a top-level attribute, read up to the end of its line at depth zero
function attributeExpression(maskedBody, name) {
  const top = topLevel(maskedBody)
  const found = new RegExp(`(^|\\n)[ \\t]*${name}[ \\t]*=`).exec(top)
  if (found === null) return null
  let k = found.index + found[0].length
  let depth = 0
  const start = k
  for (; k < maskedBody.length; k++) {
    const c = maskedBody[k]
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if (c === '\n' && depth === 0) break
  }
  return maskedBody.slice(start, k).trim()
}

// every `variable "name" { ... }` block at the top of a file
export function variables(text) {
  const masked = mask(text)
  const found = []
  const opening = /(^|\n)[ \t]*variable[ \t]+"/g
  let match
  while ((match = opening.exec(masked)) !== null) {
    const nameStart = match.index + match[0].length
    const nameEnd = masked.indexOf('"', nameStart)
    const open = masked.indexOf('{', nameEnd)
    const close = closingBrace(masked, open)
    if (nameEnd === -1 || open === -1 || close === -1)
      throw new Error(`unbalanced variable block at line ${lineAt(text, match.index)}`)
    const body = masked.slice(open + 1, close)
    const type = attributeExpression(body, 'type')
    found.push({
      name: text.slice(nameStart, nameEnd),
      line: lineAt(text, nameStart),
      sensitive: /(^|\n)[ \t]*sensitive[ \t]*=[ \t]*true[ \t]*(\n|$)/.test(topLevel(body)),
      // every name a type expression assigns, at any depth: the attributes of an object, and of objects inside it
      attributes:
        type === null ? [] : [...new Set([...type.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)[ \t]*=/g)].map((m) => m[1]))],
    })
    opening.lastIndex = close
  }
  return found
}
