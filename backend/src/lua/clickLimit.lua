if redis.call('EXISTS', KEYS[1]) == 0 then
  if ARGV[1] == '' then
    return -1
  end
  redis.call('SET', KEYS[1], ARGV[1])
end
return redis.call('INCR', KEYS[1])
