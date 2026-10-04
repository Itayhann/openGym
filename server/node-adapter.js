/* Adapts the handler to Node's (req, res) — used by the Vercel function and the local dev server. */
async function readBody(req) {
  // Vercel's Node runtime may already have consumed the stream and exposed the parsed body.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8')
    return JSON.stringify(req.body)
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export function nodeListener(handle) {
  return async (req, res) => {
    let out
    try {
      out = await handle({ method: req.method, url: req.url, headers: req.headers, body: await readBody(req) })
    } catch (e) {
      console.error('unhandled', e)
      out = { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: '{"error":"server error"}' }
    }
    res.statusCode = out.status
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v)
    res.end(out.body)
  }
}
