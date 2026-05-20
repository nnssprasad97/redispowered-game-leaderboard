import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  connectRedis,
  redisClient,
  redisSubscriber,
  createSession,
  submitAnswer
} from './redis.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.API_PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const ping = await redisClient.ping();
    if (ping === 'PONG') {
      res.status(200).json({ status: 'OK', redis: 'CONNECTED' });
    } else {
      res.status(500).json({ status: 'ERROR', redis: 'DISCONNECTED' });
    }
  } catch (error) {
    res.status(500).json({ status: 'ERROR', message: error.message });
  }
});

/**
 * 3. POST /api/sessions
 * Create user session. Invalidates old sessions using Lua.
 */
app.post('/api/sessions', async (req, res) => {
  const { userId, ipAddress, deviceType } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  
  const sessionId = uuidv4();
  
  try {
    // 30 minutes sliding expiration
    const ttl = 1800;
    await createSession({
      userId,
      sessionId,
      ipAddress: ipAddress || '127.0.0.1',
      deviceType: deviceType || 'unknown',
      ttl
    });
    
    res.status(201).json({ sessionId });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * 5. POST /api/leaderboard/scores
 * Submit or update a player's score on the global leaderboard atomically.
 */
app.post('/api/leaderboard/scores', async (req, res) => {
  const { playerId, points } = req.body;
  
  if (!playerId || points === undefined) {
    return res.status(400).json({ error: 'playerId and points are required' });
  }
  
  try {
    // Increment atomically in Sorted Set
    const newScore = await redisClient.zIncrBy('leaderboard:global', points, playerId);
    
    // Broadcast event
    await redisClient.publish('game-events', JSON.stringify({
      event: 'leaderboard_updated',
      data: { playerId, newScore }
    }));
    
    res.status(200).json({ playerId, newScore });
  } catch (error) {
    console.error('Score submission error:', error);
    res.status(500).json({ error: 'Failed to submit score' });
  }
});

/**
 * 6. GET /api/leaderboard/top/:count
 * Query top players on the leaderboard.
 */
app.get('/api/leaderboard/top/:count', async (req, res) => {
  const count = parseInt(req.params.count, 10);
  
  if (isNaN(count) || count <= 0) {
    return res.status(400).json({ error: 'Count must be a positive integer' });
  }
  
  try {
    const list = await redisClient.zRangeWithScores('leaderboard:global', 0, count - 1, { REV: true });
    
    const formatted = list.map((item, idx) => ({
      rank: idx + 1,
      playerId: item.value,
      score: item.score
    }));
    
    res.status(200).json(formatted);
  } catch (error) {
    console.error('Fetch top leaderboard error:', error);
    res.status(500).json({ error: 'Failed to retrieve leaderboard' });
  }
});

/**
 * 6. GET /api/leaderboard/player/:playerId
 * Query rank, percentile, and surrounding context for a specific player.
 */
app.get('/api/leaderboard/player/:playerId', async (req, res) => {
  const { playerId } = req.params;
  
  try {
    const score = await redisClient.zScore('leaderboard:global', playerId);
    
    if (score === null) {
      return res.status(404).json({ error: `Player ${playerId} not found on leaderboard` });
    }
    
    const revRank = await redisClient.zRevRank('leaderboard:global', playerId);
    const rank = revRank + 1;
    const N = await redisClient.zCard('leaderboard:global');
    
    // Calculate percentile: ((N - rank) / (N - 1)) * 100 or ((N - rank + 1) / N) * 100
    // Let's use the standard formula matching 95.5 at rank 10 out of 201 players
    const percentile = N > 1 ? Number(((N - rank) / (N - 1) * 100).toFixed(1)) : 100.0;
    
    // Fetch 2 players above (ranks revRank-2, revRank-1)
    let above = [];
    if (revRank > 0) {
      const startIdx = Math.max(0, revRank - 2);
      const endIdx = revRank - 1;
      const aboveList = await redisClient.zRangeWithScores('leaderboard:global', startIdx, endIdx, { REV: true });
      above = aboveList.map((item, idx) => ({
        rank: startIdx + idx + 1,
        playerId: item.value,
        score: item.score
      }));
    }
    
    // Fetch 2 players below (ranks revRank+1, revRank+2)
    const belowList = await redisClient.zRangeWithScores('leaderboard:global', revRank + 1, revRank + 2, { REV: true });
    const below = belowList.map((item, idx) => ({
      rank: revRank + 1 + idx + 1,
      playerId: item.value,
      score: item.score
    }));
    
    res.status(200).json({
      playerId,
      score,
      rank,
      percentile,
      nearbyPlayers: {
        above,
        below
      }
    });
  } catch (error) {
    console.error('Fetch player ranking error:', error);
    res.status(500).json({ error: 'Failed to retrieve player ranking details' });
  }
});

/**
 * 7. POST /api/game/submit
 * Process player's answer to a quiz question atomically using Lua.
 */
app.post('/api/game/submit', async (req, res) => {
  const { gameId, roundId, playerId, answer } = req.body;
  
  if (!gameId || !roundId || !playerId || answer === undefined) {
    return res.status(400).json({ error: 'gameId, roundId, playerId, and answer are required' });
  }
  
  try {
    const result = await submitAnswer({
      gameId,
      roundId,
      playerId,
      answer,
      currentTime: Date.now(),
      defaultPoints: 10
    });
    
    if (result.status === 'ERROR') {
      if (result.payload === 'ROUND_EXPIRED') {
        return res.status(403).json({ status: 'ERROR', code: 'ROUND_EXPIRED' });
      } else if (result.payload === 'DUPLICATE_SUBMISSION') {
        return res.status(400).json({ status: 'ERROR', code: 'DUPLICATE_SUBMISSION' });
      } else {
        return res.status(400).json({ status: 'ERROR', code: result.payload });
      }
    }
    
    const newScore = parseInt(result.payload, 10);
    
    // Broadcast event
    await redisClient.publish('game-events', JSON.stringify({
      event: 'leaderboard_updated',
      data: { playerId, newScore }
    }));
    
    // Also publish a submission event for the event stream ticker
    await redisClient.publish('game-events', JSON.stringify({
      event: 'answer_submitted',
      data: { playerId, gameId, roundId, isCorrect: result.isCorrect, answer }
    }));
    
    res.status(200).json({ status: 'SUCCESS', newScore });
  } catch (error) {
    console.error('Quiz submission error:', error);
    res.status(500).json({ error: 'Failed to submit quiz answer' });
  }
});

/**
 * 8. GET /api/events
 * Server-Sent Events (SSE) streaming endpoint.
 */
app.get('/api/events', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  res.write('\n'); // Send initial ping
  
  const listener = (message) => {
    try {
      const parsed = JSON.parse(message);
      res.write(`event: ${parsed.event}\n`);
      res.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
    } catch (e) {
      res.write(`event: message\n`);
      res.write(`data: ${message}\n\n`);
    }
  };
  
  try {
    await redisSubscriber.subscribe('game-events', listener);
  } catch (error) {
    console.error('SSE subscription error:', error);
  }
  
  req.on('close', async () => {
    try {
      await redisSubscriber.unsubscribe('game-events', listener);
    } catch (error) {
      console.error('SSE unsubscribe error:', error);
    }
  });
});

/**
 * 9. GET /api/admin/sessions/user/:userId
 * Retrieve active sessions for a user.
 */
app.get('/api/admin/sessions/user/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const sessionIds = await redisClient.sMembers(`user_sessions:${userId}`);
    const sessions = [];
    const expiredSessionIds = [];
    
    for (const sessionId of sessionIds) {
      const data = await redisClient.hGetAll(`session:${sessionId}`);
      if (data && Object.keys(data).length > 0) {
        sessions.push({
          sessionId,
          ipAddress: data.ipAddress,
          lastActive: data.lastActive,
          deviceType: data.deviceType
        });
      } else {
        expiredSessionIds.push(sessionId);
      }
    }
    
    // Clean up expired session IDs from set
    if (expiredSessionIds.length > 0) {
      await redisClient.sRem(`user_sessions:${userId}`, expiredSessionIds);
    }
    
    res.status(200).json(sessions);
  } catch (error) {
    console.error('Admin get sessions error:', error);
    res.status(500).json({ error: 'Failed to retrieve active user sessions' });
  }
});

/**
 * 9. DELETE /api/admin/sessions/:sessionId
 * Invalidate a specific user session.
 */
app.delete('/api/admin/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    // 1. Find userId of the session to clean up the secondary set index
    const userId = await redisClient.hGet(`session:${sessionId}`, 'userId');
    
    // 2. Delete the session hash
    await redisClient.del(`session:${sessionId}`);
    
    // 3. Remove the session from the user's active sessions set
    if (userId) {
      await redisClient.sRem(`user_sessions:${userId}`, sessionId);
    }
    
    res.status(204).send();
  } catch (error) {
    console.error('Admin delete session error:', error);
    res.status(500).json({ error: 'Failed to invalidate session' });
  }
});

/**
 * Helper admin endpoint: POST /api/admin/rounds
 * Seed/Create a quiz round state in Redis.
 */
app.post('/api/admin/rounds', async (req, res) => {
  const { gameId, roundId, durationSeconds, correctAnswer, points } = req.body;
  
  if (!gameId || !roundId) {
    return res.status(400).json({ error: 'gameId and roundId are required' });
  }
  
  try {
    const duration = durationSeconds || 60;
    const endTime = Date.now() + duration * 1000;
    const roundKey = `game_round:${gameId}:${roundId}`;
    
    await redisClient.hSet(roundKey, {
      endTime: endTime.toString(),
      correctAnswer: correctAnswer || 'Redis',
      points: (points || 10).toString()
    });
    
    // Optional round expiration on Redis key itself (e.g. clean up after 1 hour)
    await redisClient.expire(roundKey, 3600);
    
    // Clear old submissions for this round to make it fresh
    await redisClient.del(`submissions:${gameId}:${roundId}`);
    
    res.status(201).json({
      gameId,
      roundId,
      endTime,
      correctAnswer: correctAnswer || 'Redis',
      points: points || 10
    });
  } catch (error) {
    console.error('Seed round error:', error);
    res.status(500).json({ error: 'Failed to seed game round' });
  }
});

// Initialize connections and start server
async function startServer() {
  try {
    await connectRedis();
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start API server:', error);
    process.exit(1);
  }
}

startServer();
