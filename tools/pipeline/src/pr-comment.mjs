// Creates a pull request comment, or edits the one this workflow posted before, found by a hidden marker at the
// start of its body. Only comments by the Actions bot are considered, so a person's comment that quotes the
// marker is never taken for it.
export const BOT = 'github-actions[bot]'

export async function upsertComment({ api, token, repository, issue, marker, body, fetch = globalThis.fetch }) {
  const call = async (method, path, payload) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    // the status and the path only: the token is in the request, never in what is thrown
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${method} ${path}`)
    return response.json()
  }

  for (let page = 1; ; page++) {
    const comments = await call('GET', `/repos/${repository}/issues/${issue}/comments?per_page=100&page=${page}`)
    const ours = comments.find((c) => c?.user?.login === BOT && typeof c.body === 'string' && c.body.startsWith(marker))
    if (ours !== undefined) {
      await call('PATCH', `/repos/${repository}/issues/comments/${ours.id}`, { body })
      return { action: 'updated', id: ours.id }
    }
    if (comments.length < 100) break
  }
  const created = await call('POST', `/repos/${repository}/issues/${issue}/comments`, { body })
  return { action: 'created', id: created.id }
}
