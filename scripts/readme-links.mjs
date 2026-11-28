/**
 * @fileoverview The link section of the published-surface gate: every link and anchor in the
 * README points somewhere real.
 * @layer scripts
 */

import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// 1. Every link in the README points somewhere real. A bad HTTP status fails the
//    gate; a link the machine could not reach at all is reported as a note, since
//    an offline runner is not a defect in the documentation.
// ---------------------------------------------------------------------------

/** Slug a Markdown heading the way GitHub does. Deliberately does NOT trim: the
 * space an emoji leaves behind becomes a leading hyphen, so `## 🚀 Quick Start`
 * is `#-quick-start` and not `#quick-start`. Trimming here would report every
 * correct emoji anchor in the file as broken. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/gu, '')
    .replace(/\s/g, '-')
}

/** Classifies a bare IP address as one a documentation link must not reach, or
 * null when it is ordinary public space. Shared by the literal check and the
 * resolved-address check, so both answer with the same vocabulary. */
function privateAddressReason(ip) {
  const h = ip.toLowerCase()
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127) return 'a loopback address'
    // 0.0.0.0/8 is "this network" — 0.0.0.0 is the address a socket binds to
    // for "everything", and the rest of the block is not routable either.
    if (a === 0) return 'in the unspecified network (0.0.0.0/8)'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return 'a private address'
    }
    if (a === 169 && b === 254) return 'a link-local address (cloud metadata range)'
    return null
  }
  if (h === '::1') return 'a loopback address'
  if (h === '::') return 'the unspecified address'
  if (h.startsWith('::ffff:')) return privateAddressReason(h.slice('::ffff:'.length))
  if (/^f[cd]/.test(h)) return 'a unique-local address'
  if (/^fe[89ab]/.test(h)) return 'a link-local address'
  return null
}

/** Hosts a documentation link must never point at. This check runs on
 * `pull_request`, so without it a fork could put `https://169.254.169.254/…` or a
 * loopback address in the README and have the CI runner probe it — the runner
 * reaching an endpoint the author cannot reach themselves. Rejected before the
 * request, not after, and reported as a finding rather than skipped: a published
 * README has no business linking to a private address either way.
 *
 * Every bare IP literal is refused, not just the private ranges. Enumerating
 * ranges means enumerating them again for IPv6, and again for whatever notation
 * is missed next; a documentation link points at a hostname, so the whole class
 * can go. The private ranges keep their own message because naming the range is
 * the more useful diagnosis when a link does hit one.
 *
 * A hostname is resolved before it is fetched, because a name pointed at
 * 169.254.169.254 reaches the same endpoint an IP literal would. This narrows
 * the hole rather than closing it: the fetch resolves the name a second time, so
 * a record that changes between the two calls still gets through. Closing that
 * needs the resolved address pinned into the connection, which is more machinery
 * than a documentation gate warrants — a static private record is the case worth
 * stopping, and this stops it. A name that does not resolve at all is left to the
 * fetch, which reports an unreachable host as a note. */
async function unroutableReason(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return 'is not a valid URL'
  }
  if (u.protocol !== 'https:') return `uses ${u.protocol.replace(':', '')}, not https`
  // A fully-qualified name keeps its trailing dot through the URL parser, and
  // `localhost.` resolves exactly like `localhost` — so the dot has to go
  // before the name is compared, or it is a one-character bypass.
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return 'is a loopback name'
  if (h.endsWith('.local')) return 'is an mDNS name, resolvable only on the local link'
  // A URL parser brackets every IPv6 literal, so the brackets are the test —
  // no need to recognise the address notation itself.
  if (h.startsWith('[')) {
    const reason = privateAddressReason(h.slice(1, -1))
    return reason ? `is ${reason}` : 'is an IPv6 literal, not a hostname'
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const reason = privateAddressReason(h)
    return reason ? `is ${reason}` : 'is an IPv4 literal, not a hostname'
  }
  let addresses
  try {
    // Bounded like the fetch below is. A resolver that hangs would otherwise
    // stall Promise.all indefinitely and take CI with it, and a lookup that
    // cannot answer in five seconds tells us nothing anyway. `unref` so a
    // pending timer never holds the process open.
    addresses = await Promise.race([
      // The losing promise keeps running after the race resolves, so a lookup
      // that rejects late would surface as an unhandled rejection. Swallowed
      // here into the same "could not resolve" answer the catch below gives.
      lookup(h, { all: true }).catch(() => null),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(null)
        }, 5_000).unref()
      })
    ])
  } catch {
    return null
  }
  // Unresolvable, or slower than the bound: left to the fetch, which reports an
  // unreachable host as a note rather than failing the gate.
  if (!addresses) return null
  for (const { address } of addresses) {
    const reason = privateAddressReason(address)
    if (reason) return `resolves to ${address}, which is ${reason}`
  }
  return null
}

/** Thrown when a hop in a redirect chain points somewhere the guard refuses.
 * Distinguished from a transport error so it fails the gate instead of
 * degrading to a note — a redirect into private space is a finding, not an
 * outage. */
class UnroutableRedirect extends Error {}

/** `fetch` with the redirect chain followed by hand, because `redirect:
 * 'follow'` would check only the URL written in the README. A public host is
 * free to answer 302 with `Location: http://169.254.169.254/…`, and the runner
 * would follow it — the very thing `unroutableReason` exists to stop. Every hop
 * is validated before it is requested, and the chain is bounded: a redirect loop
 * must not spin inside a release gate. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

async function fetchChecked(url, init, hops = 0) {
  if (hops > 5) throw new UnroutableRedirect('follows more than 5 redirects')
  const res = await fetch(url, { ...init, redirect: 'manual' })
  // The statuses the Fetch standard actually redirects on. `3xx` is wider than
  // that — a 304 or a 300 is a response to return, not a hop to follow.
  if (!REDIRECT_STATUSES.has(res.status)) return res
  const location = res.headers.get('location')
  if (!location) return res
  // Release the socket before the next hop: undici holds the connection until
  // the body is read or cancelled, and this runs across every README link at
  // once.
  await res.body?.cancel().catch(() => undefined)
  let next
  try {
    next = new URL(location, url).href
  } catch {
    // A Location that does not parse is a defect in the chain, not an outage,
    // so it must not fall through to the transport-error note below.
    throw new UnroutableRedirect(`redirects to an unparsable location: ${location}`)
  }
  const reason = await unroutableReason(next)
  if (reason) throw new UnroutableRedirect(`redirects to ${next}, which ${reason}`)
  return fetchChecked(next, init, hops + 1)
}

/** Checks the README's anchors, relative links and external links, reporting each problem
 * through `fail`. `root` is the repository directory relative links resolve against. */
export async function checkLinks({ readme, root, fail }) {
  // A `# Using pnpm` inside a ```bash fence is a shell comment, not a heading, and letting it
  // into the anchor set makes a broken anchor pass.
  const prose = readme.replace(/^```[\s\S]*?^```$/gm, '')
  const anchors = new Set([...prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => `#${slug(m[1])}`))
  // Only follow links a reader clicks. A badge is `[![alt](image)](target)`, and a naive link regex
  // captures the IMAGE, probing shields.io on every run. The image is stripped so only the target remains.
  //
  // Collection starts from the prose, like the anchor set: an `<a href="${url}">` inside a fence
  // is a string an example builds at runtime, not a link a reader can click, and the checker
  // cannot resolve a placeholder.
  const clickable = prose.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  const links = new Set([
    ...[...clickable.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]),
    ...[...clickable.matchAll(/<a\s+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
  ])
  // Both spellings: the section links are Markdown, the header navigation is raw HTML.
  const internal = new Set([
    ...[...prose.matchAll(/\[[^\]]*\]\((#[^)\s]+)\)/g)].map((m) => m[1].toLowerCase()),
    ...[...prose.matchAll(/<a\s+href="(#[^"]+)"/g)].map((m) => m[1].toLowerCase())
  ])

  // Relative links are the ones most likely to rot — a file gets renamed and
  // nothing outside the README notices. They cost no network to verify, and the
  // section above claims to check every link, so it has to mean every link.
  const relative = new Set(
    [
      ...[...clickable.matchAll(/\[[^\]]*\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)].map((m) => m[1]),
      ...[...clickable.matchAll(/<a\s+href="(?!https?:|#|mailto:)([^"]+)"/g)].map((m) => m[1])
    ]
      .map((target) => target.split('#')[0])
      .filter(Boolean)
  )

  for (const a of internal) {
    if (!anchors.has(a)) fail('links', `anchor ${a} matches no heading`)
  }
  for (const r of relative) {
    // Resolve and confine before touching the filesystem. `..` segments would
    // otherwise walk out of the repository and have the runner stat arbitrary
    // paths, and a link that escapes the repository is broken documentation
    // regardless — the file it names is not in the package.
    const target = resolve(root, r.replace(/^\/+/, ''))
    if (target !== root && !target.startsWith(root + sep)) {
      fail('links', `${r} resolves outside the repository`)
    } else if (!existsSync(target)) {
      fail('links', `${r} does not exist in the repository`)
    }
  }

  const results = await Promise.all(
    [...links].map(async (url) => {
      const unroutable = await unroutableReason(url)
      if (unroutable) return `${url} → ${unroutable}`

      // npmjs.com serves 403 to any datacenter IP, browser User-Agent included, so asking it whether
      // a package page exists measures Cloudflare rather than the package. The registry answers the
      // same question honestly: this redirects the check, it does not suppress it, and a package the
      // registry does not know is a note, expected until its first publish.
      const probe = url.replace(
        /^https:\/\/www\.npmjs\.com\/package\/(.+)$/,
        (_, name) => `https://registry.npmjs.org/${encodeURIComponent(name)}`
      )
      // The rewrite changes what is requested, so nothing may be requested before it is validated:
      // the guard must hold for the rewritten target too, not only while it is a fixed registry host.
      if (probe !== url) {
        const rewritten = await unroutableReason(probe)
        if (rewritten) return `${url} → rewritten to ${probe}, which ${rewritten}`
      }
      const headers = { 'user-agent': 'Mozilla/5.0 (compatible; bymax-docs-gate)' }
      try {
        // HEAD first; some hosts answer it with 405, so fall back to GET.
        // One signal bounds each LINK, not each request: it covers the HEAD, the GET fallback and
        // every redirect hop together, because what must not stall a publish is the check of one link.
        //
        // It covers the requests only. Each hop's `unroutableReason` runs a DNS lookup with its own 5s
        // bound, outside this signal, so a chain's worst case is this timeout plus one lookup per hop.
        // Both are bounded; they are not one budget.
        const opts = { headers, signal: AbortSignal.timeout(10_000) }
        let res = await fetchChecked(probe, { method: 'HEAD', ...opts })
        if (res.status === 405 || res.status === 403 || res.status === 429) {
          await res.body?.cancel().catch(() => undefined)
          res = await fetchChecked(probe, { method: 'GET', ...opts })
        }
        // Only the status is ever read. undici holds the connection until the
        // body is read or cancelled, and this runs across every link at once.
        await res.body?.cancel().catch(() => undefined)
        if (res.ok) return null
        // A package page 404s until the first publish. Reported, never fatal:
        // failing here would block the very release that makes the link true.
        if (res.status === 404 && probe !== url) {
          console.log(`  note: ${url} is not live yet — expected until the first publish`)
          return null
        }
        // A host that answers 5xx, or 429 again after the GET above, is in trouble of its own, and a link
        // check cannot tell that from a dead link. Reported like a transport error, never fatal: this gate
        // also guards `prepublishOnly`, and someone else's outage must not block a release. 404, 410 and the
        // other client errors still fail.
        if (res.status >= 500 || res.status === 429) {
          console.log(
            `  note: ${url} answered HTTP ${res.status}, the host's trouble and not proof that the link is dead`
          )
          return null
        }
        return `${url} → HTTP ${res.status}`
      } catch (err) {
        // A refused redirect is a finding about the link itself, not someone
        // else's outage, so it fails rather than degrading to a note.
        if (err instanceof UnroutableRedirect) return `${url} → ${err.message}`
        // A transport error cannot tell "this link is dead" from "that host is
        // down right now". Reported, never fatal — this gate also guards
        // `prepublishOnly`, and someone else's outage must not block a release.
        console.log(
          `  note: ${url} could not be reached (${err instanceof Error ? err.message : String(err)})`
        )
        return null
      }
    })
  )
  for (const r of results) if (r) fail('links', r)
  console.log(
    `  links: ${links.size} external, ${internal.size} internal, ${relative.size} relative`
  )
}
