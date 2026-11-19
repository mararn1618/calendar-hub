const MINUTE = 60_000
const HOUR = 60 * MINUTE
const MAX_DATE = 8.64e15

function retryTime(header, now) {
  if (typeof header !== 'string') return
  const value = header.trim()
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    if (seconds > 0) return Math.min(MAX_DATE, now + seconds * 1000)
    return
  }
  const weekday = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/
  if (!weekday.test(value)) return
  const asctime = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/.test(value)
  const gmtDate = /^[A-Z][a-z]+, (?:\d{2} [A-Z][a-z]{2} \d{4}|\d{2}-[A-Z][a-z]{2}-\d{2}) \d\d:\d\d:\d\d GMT$/
  if (!asctime && !gmtDate.test(value)) return
  const time = Date.parse(asctime ? value + ' GMT' : value)
  if (Number.isFinite(time) && time > now) return time
}

function limited(retryAt) {
  const time = new Date(retryAt).toLocaleString()
  return Object.assign(new Error('TickTick reached its request limit. Try again after ' + time + '.'), {
    code: 'RATE_LIMITED', status: 429, retryAt,
  })
}

export function tickTickCooldown(rateLimit, now = Date.now()) {
  if (Number.isFinite(rateLimit?.retryAt) && rateLimit.retryAt > now) return limited(rateLimit.retryAt)
}

export function recordTickTickRateLimit(rateLimit, retryAfter, now = Date.now(), endpoint) {
  const previous = rateLimit.retryAt || 0
  const attempts = Number.isInteger(rateLimit.attempts) && now - previous < HOUR ? rateLimit.attempts : 0
  rateLimit.attempts = Math.max(1, Math.min(7, attempts + (previous > now ? 0 : 1)))
  const fallback = Math.min(HOUR, MINUTE * 2 ** (rateLimit.attempts - 1))
  rateLimit.retryAt = Math.max(previous, retryTime(retryAfter, now) ?? now + fallback)
  if (endpoint) rateLimit.endpoint = endpoint
  return limited(rateLimit.retryAt)
}

export function clearRecoveredLimit(rateLimit, previousRetryAt, endpoint, now) {
  if (previousRetryAt === undefined || previousRetryAt !== rateLimit.retryAt || previousRetryAt > now) return false
  if (rateLimit.endpoint && rateLimit.endpoint !== endpoint && now - previousRetryAt < HOUR) return false
  delete rateLimit.retryAt
  delete rateLimit.attempts
  delete rateLimit.endpoint
  return true
}
