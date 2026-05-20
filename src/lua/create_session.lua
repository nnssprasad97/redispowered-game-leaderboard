-- KEYS[1] = user_sessions:{userId}
-- KEYS[2] = session:{newSessionId}
-- ARGV[1] = newSessionId
-- ARGV[2] = userId
-- ARGV[3] = createdAt
-- ARGV[4] = lastActive
-- ARGV[5] = ipAddress
-- ARGV[6] = deviceType
-- ARGV[7] = ttl

-- 1. Get all active sessions for this user
local old_sessions = redis.call('SMEMBERS', KEYS[1])

-- 2. Delete each old session key
for _, session_id in ipairs(old_sessions) do
    local old_session_key = "session:" .. session_id
    redis.call('DEL', old_session_key)
end

-- 3. Delete the set listing sessions for this user
redis.call('DEL', KEYS[1])

-- 4. Add the new session to the user's sessions set
redis.call('SADD', KEYS[1], ARGV[1])

-- 5. Create the new session hash
redis.call('HSET', KEYS[2],
    'userId', ARGV[2],
    'createdAt', ARGV[3],
    'lastActive', ARGV[4],
    'ipAddress', ARGV[5],
    'deviceType', ARGV[6]
)

-- 6. Set TTL for the new session hash
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))

return ARGV[1]
