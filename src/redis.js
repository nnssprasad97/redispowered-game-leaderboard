import { createClient } from 'redis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

console.log(`Connecting to Redis at: ${redisUrl}`);

export const redisClient = createClient({ url: redisUrl });
export const redisSubscriber = createClient({ url: redisUrl });

// Cache Lua script contents
let createSessionScript = '';
let submitAnswerScript = '';

try {
  createSessionScript = fs.readFileSync(path.join(__dirname, 'lua', 'create_session.lua'), 'utf8');
  submitAnswerScript = fs.readFileSync(path.join(__dirname, 'lua', 'submit_answer.lua'), 'utf8');
} catch (error) {
  console.error('Failed to load Lua scripts:', error);
}

redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisSubscriber.on('error', (err) => console.error('Redis Subscriber Error', err));

export async function connectRedis() {
  await redisClient.connect();
  console.log('Connected to Redis main client');
  await redisSubscriber.connect();
  console.log('Connected to Redis subscriber client');
}

/**
 * Creates a user session atomically, invalidating old sessions.
 */
export async function createSession({ userId, sessionId, ipAddress, deviceType, ttl = 1800 }) {
  const createdAt = new Date().toISOString();
  const lastActive = createdAt;
  
  const keys = [
    `user_sessions:${userId}`,
    `session:${sessionId}`
  ];
  
  const args = [
    sessionId,
    userId,
    createdAt,
    lastActive,
    ipAddress,
    deviceType,
    ttl.toString()
  ];
  
  return await redisClient.eval(createSessionScript, {
    keys,
    arguments: args
  });
}

/**
 * Submits an answer atomically.
 */
export async function submitAnswer({ gameId, roundId, playerId, answer, currentTime, defaultPoints = 10 }) {
  const keys = [
    `game_round:${gameId}:${roundId}`,
    `submissions:${gameId}:${roundId}`,
    'leaderboard:global'
  ];
  
  const args = [
    playerId,
    answer,
    currentTime.toString(),
    defaultPoints.toString()
  ];
  
  // Lua returns an array: [status, score_str, is_correct_str]
  const result = await redisClient.eval(submitAnswerScript, {
    keys,
    arguments: args
  });
  
  return {
    status: result[0], // 'SUCCESS' or 'ERROR'
    payload: result[1], // newScore (if success) or error code (if error)
    isCorrect: result[2] === 'true'
  };
}
