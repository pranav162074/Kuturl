-- Token bucket. One Redis hash per bucket holds the current tokens and the time they were
-- last updated. This whole script runs as one atomic step, so simultaneous requests (from any
-- number of app instances) can never both spend the same token.
--
-- KEYS[1]  the bucket key
-- ARGV[1]  capacity: the most tokens a bucket can hold, which is also the largest burst
-- ARGV[2]  refill rate, in tokens per second
-- ARGV[3]  cost: tokens this request needs (1 for a normal request)
--
-- Returns { allowed (1 or 0), whole tokens left, ms until the request would be allowed,
--           ms until the bucket is full again }

local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

-- Redis's own clock, so app instances with different clocks still agree
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local last = tonumber(state[2])

-- A bucket that does not exist yet starts full
if tokens == nil or last == nil then
  tokens = capacity
  last = now
end

-- Add the tokens earned since the last request, up to the capacity
local elapsed = math.max(0, now - last)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / rate * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))

-- A bucket that has refilled completely behaves exactly like a new one, so it can expire
local untilFull = math.ceil((capacity - tokens) / rate * 1000)
redis.call('PEXPIRE', KEYS[1], math.max(untilFull, 1000))

return { allowed, math.floor(tokens), retry, untilFull }