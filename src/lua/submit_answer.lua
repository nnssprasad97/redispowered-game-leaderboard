-- KEYS[1] = game_round:{gameId}:{roundId}
-- KEYS[2] = submissions:{gameId}:{roundId}
-- KEYS[3] = leaderboard:global
-- ARGV[1] = playerId
-- ARGV[2] = answer
-- ARGV[3] = currentTime (Unix timestamp in ms or s)
-- ARGV[4] = defaultPoints

-- 1. Fetch round metadata (endTime, correctAnswer, points)
local end_time = redis.call('HGET', KEYS[1], 'endTime')

-- If round doesn't exist or doesn't have endTime, consider it expired/not active
if not end_time then
    return {'ERROR', 'ROUND_EXPIRED'}
end

-- 2. Check if the round window is closed
if tonumber(ARGV[3]) >= tonumber(end_time) then
    return {'ERROR', 'ROUND_EXPIRED'}
end

-- 3. Check for duplicate submission
local already_submitted = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if already_submitted == 1 then
    return {'ERROR', 'DUPLICATE_SUBMISSION'}
end

-- 4. Record submission
redis.call('SADD', KEYS[2], ARGV[1])

-- 5. Validate the answer and calculate points
local correct_answer = redis.call('HGET', KEYS[1], 'correctAnswer')
local round_points = redis.call('HGET', KEYS[1], 'points')
local points_to_add = 0
local is_correct = false

-- Normalize correct answer and user answer for comparison (case-insensitive, trimmed)
local function trim_and_lower(str)
    if not str then return "" end
    -- Basic trim space pattern
    local s = str:gsub("^%s*(.-)%s*$", "%1")
    return string.lower(s)
end

local user_ans = trim_and_lower(ARGV[2])
local corr_ans = trim_and_lower(correct_answer)

if corr_ans == "" or user_ans == corr_ans then
    points_to_add = tonumber(round_points) or tonumber(ARGV[4]) or 10
    is_correct = true
end

-- 6. Atomically update the player's score
local new_score = 0
if points_to_add > 0 then
    new_score = tonumber(redis.call('ZINCRBY', KEYS[3], points_to_add, ARGV[1]))
else
    -- If no points to add, fetch current score
    local current_score = redis.call('ZSCORE', KEYS[3], ARGV[1])
    new_score = tonumber(current_score) or 0
end

-- Return success state, the new score, and whether the answer was correct
return {'SUCCESS', tostring(new_score), is_correct and 'true' or 'false'}
