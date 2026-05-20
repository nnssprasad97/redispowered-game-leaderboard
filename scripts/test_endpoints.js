import { createClient } from 'redis';

const API_PORT = process.env.API_PORT || 3000;
const API_URL = `http://localhost:${API_PORT}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function runTests() {
  console.log('--- STARTING LEADERBOARD BACKEND TEST SUITE ---');
  
  const redis = createClient({ url: REDIS_URL });
  await redis.connect();
  
  // Clear any existing keys for our specific test namespace to keep runs clean
  await redis.del('user_sessions:test-user-123');
  await redis.del('leaderboard:global');
  await redis.del('submissions:game-test:round-test');
  await redis.del('game_round:game-test:round-test');
  
  let passedCount = 0;
  let failedCount = 0;
  
  function assert(condition, message) {
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passedCount++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failedCount++;
    }
  }

  try {
    // 1. Health Endpoint
    console.log('\nTesting /health...');
    const healthRes = await fetch(`${API_URL}/health`);
    const healthData = await healthRes.json();
    assert(healthRes.status === 200, 'Health endpoint returned 200');
    assert(healthData.status === 'OK' && healthData.redis === 'CONNECTED', 'Health check reports OK and Redis Connected');

    // 2. Session Creation (POST /api/sessions)
    console.log('\nTesting Session Creation (POST /api/sessions)...');
    const user = 'test-user-123';
    const s1Res = await fetch(`${API_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user,
        ipAddress: '192.168.1.5',
        deviceType: 'desktop-chrome'
      })
    });
    
    assert(s1Res.status === 201, 'Session 1 response is 201 Created');
    const s1Data = await s1Res.json();
    const s1Id = s1Data.sessionId;
    assert(typeof s1Id === 'string' && s1Id.length > 0, `Session 1 ID created: ${s1Id}`);
    
    // Verify Redis State
    const s1Hash = await redis.hGetAll(`session:${s1Id}`);
    assert(s1Hash.userId === user, 'Hash contains correct userId');
    assert(s1Hash.ipAddress === '192.168.1.5', 'Hash contains correct ipAddress');
    assert(s1Hash.deviceType === 'desktop-chrome', 'Hash contains correct deviceType');
    
    const ttl = await redis.ttl(`session:${s1Id}`);
    assert(ttl > 1700 && ttl <= 1800, `Session Hash TTL is valid: ${ttl}s`);
    
    const isMember = await redis.sIsMember(`user_sessions:${user}`, s1Id);
    assert(isMember === true, 'Session ID added to user_sessions set index');

    // 3. Atomic Session Invalidation
    console.log('\nTesting Atomic Session Invalidation...');
    // Create second session for same user
    const s2Res = await fetch(`${API_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user,
        ipAddress: '10.0.0.8',
        deviceType: 'mobile-safari'
      })
    });
    
    assert(s2Res.status === 201, 'Session 2 response is 201 Created');
    const s2Data = await s2Res.json();
    const s2Id = s2Data.sessionId;
    
    // Verify that session 1 is deleted and session 2 is the only member of user_sessions set
    const s1Exists = await redis.exists(`session:${s1Id}`);
    const s2Exists = await redis.exists(`session:${s2Id}`);
    assert(s1Exists === 0, 'Old session key deleted atomically');
    assert(s2Exists === 1, 'New session key exists');
    
    const activeSessions = await redis.sMembers(`user_sessions:${user}`);
    assert(activeSessions.length === 1 && activeSessions[0] === s2Id, 'user_sessions set contains ONLY the new session ID');

    // 4. Leaderboard Score Submit (POST /api/leaderboard/scores)
    console.log('\nTesting Leaderboard Score Submission (POST /api/leaderboard/scores)...');
    const p1 = 'player-alpha';
    const score1Res = await fetch(`${API_URL}/api/leaderboard/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: p1, points: 50 })
    });
    
    assert(score1Res.status === 200, 'Score 1 submission returned 200 OK');
    const score1Data = await score1Res.json();
    assert(score1Data.playerId === p1 && score1Data.newScore === 50, `Score 1 data: playerId=${score1Data.playerId}, newScore=${score1Data.newScore}`);
    
    let dbScore = await redis.zScore('leaderboard:global', p1);
    assert(dbScore === 50, `Redis ZSCORE for ${p1} is 50`);
    
    // Increment score by 25
    const score2Res = await fetch(`${API_URL}/api/leaderboard/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: p1, points: 25 })
    });
    const score2Data = await score2Res.json();
    assert(score2Data.newScore === 75, `Increment score response: newScore=${score2Data.newScore}`);
    
    dbScore = await redis.zScore('leaderboard:global', p1);
    assert(dbScore === 75, `Redis ZSCORE for ${p1} is updated to 75`);

    // 5. Query Leaderboard Top list and Player rankings
    console.log('\nTesting Leaderboard Query Endpoints...');
    // Seed 30 players
    const batch = [];
    for (let i = 1; i <= 30; i++) {
      batch.push({ score: i * 10, value: `player-seed-${i}` });
    }
    // player-alpha has 75, which will be among them
    await redis.zAdd('leaderboard:global', batch);
    
    const topRes = await fetch(`${API_URL}/api/leaderboard/top/10`);
    const topData = await topRes.json();
    assert(topRes.status === 200, 'Top 10 endpoint returned 200');
    assert(topData.length === 10, `Retrieved exactly ${topData.length} players`);
    assert(topData[0].rank === 1 && topData[0].score === 300, `Rank 1 player is ${topData[0].playerId} with ${topData[0].score} pts`);
    
    // Player ranking query for someone in the middle (e.g. player-seed-15 with score 150)
    // Ranks will be:
    // player-seed-30 (300) -> rank 1
    // ...
    // player-seed-16 (160) -> rank 15
    // player-seed-15 (150) -> rank 16
    // player-seed-14 (140) -> rank 17
    const inspectRes = await fetch(`${API_URL}/api/leaderboard/player/player-seed-15`);
    const inspectData = await inspectRes.json();
    assert(inspectRes.status === 200, 'Player inspection returned 200');
    assert(inspectData.playerId === 'player-seed-15', 'Correct playerId in payload');
    assert(inspectData.score === 150, 'Correct score in payload');
    assert(inspectData.rank === 16, `Correct rank in payload: ${inspectData.rank} (expected 16)`); // 31 total players
    assert(typeof inspectData.percentile === 'number', `Calculated percentile: ${inspectData.percentile}%`);
    
    assert(inspectData.nearbyPlayers.above.length === 2, 'Found 2 players above');
    assert(inspectData.nearbyPlayers.below.length === 2, 'Found 2 players below');
    assert(inspectData.nearbyPlayers.above[1].playerId === 'player-seed-16', `Immediate above is: ${inspectData.nearbyPlayers.above[1].playerId}`);
    assert(inspectData.nearbyPlayers.below[0].playerId === 'player-seed-14', `Immediate below is: ${inspectData.nearbyPlayers.below[0].playerId}`);

    // 6. Game Answer Submission (POST /api/game/submit) - Atomicity & Expiration
    console.log('\nTesting Quiz Submission Atomicity (POST /api/game/submit)...');
    const gId = 'game-test';
    const rId = 'round-test';
    
    // 6a. Active Round Submission
    // Seed round expiring in 10s with correct answer "Redis" worth 15 points
    const seedRes = await fetch(`${API_URL}/api/admin/rounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: gId,
        roundId: rId,
        durationSeconds: 10,
        correctAnswer: 'Redis',
        points: 15
      })
    });
    assert(seedRes.status === 201, 'Game round seeded successfully');
    
    // Submit correct answer for player-alpha
    const sub1Res = await fetch(`${API_URL}/api/game/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: gId,
        roundId: rId,
        playerId: 'player-alpha',
        answer: 'Redis'
      })
    });
    assert(sub1Res.status === 200, 'Correct answer submission returned 200');
    const sub1Data = await sub1Res.json();
    assert(sub1Data.status === 'SUCCESS', 'Response reports SUCCESS');
    assert(sub1Data.newScore === 90, `Player score updated: 75 -> ${sub1Data.newScore} (expected 90)`);

    // 6b. Duplicate submission
    const sub2Res = await fetch(`${API_URL}/api/game/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: gId,
        roundId: rId,
        playerId: 'player-alpha',
        answer: 'Redis'
      })
    });
    assert(sub2Res.status === 400, 'Duplicate submission returned 400 Bad Request');
    const sub2Data = await sub2Res.json();
    assert(sub2Data.status === 'ERROR' && sub2Data.code === 'DUPLICATE_SUBMISSION', 'Duplicate submission error code is correct');

    // 6c. Expired Round Submission
    // Seed expired round (durationSeconds: -5)
    const seedExpiredRes = await fetch(`${API_URL}/api/admin/rounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: gId,
        roundId: rId,
        durationSeconds: -5,
        correctAnswer: 'Redis',
        points: 15
      })
    });
    assert(seedExpiredRes.status === 201, 'Expired round seeded successfully');
    
    const subExpiredRes = await fetch(`${API_URL}/api/game/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: gId,
        roundId: rId,
        playerId: 'player-beta',
        answer: 'Redis'
      })
    });
    assert(subExpiredRes.status === 403, 'Expired round submission returned 403 Forbidden');
    const subExpiredData = await subExpiredRes.json();
    assert(subExpiredData.status === 'ERROR' && subExpiredData.code === 'ROUND_EXPIRED', 'Expired round error code is correct');

    // 7. Admin Endpoint tests (GET /api/admin/sessions/user/:userId & DELETE /api/admin/sessions/:sessionId)
    console.log('\nTesting Admin Sessions Management...');
    // Fetch active session for user test-user-123 (should be session s2Id)
    const adminGetRes = await fetch(`${API_URL}/api/admin/sessions/user/test-user-123`);
    assert(adminGetRes.status === 200, 'Admin get user sessions returned 200 OK');
    const adminGetData = await adminGetRes.json();
    assert(adminGetData.length === 1 && adminGetData[0].sessionId === s2Id, 'Found correct session in user active sessions array');
    
    // Invalidate the session
    const adminDelRes = await fetch(`${API_URL}/api/admin/sessions/${s2Id}`, {
      method: 'DELETE'
    });
    assert(adminDelRes.status === 204, 'Admin session invalidation returned 204 No Content');
    
    // Verify session and set membership is deleted
    const sessionExists = await redis.exists(`session:${s2Id}`);
    assert(sessionExists === 0, 'Session key has been deleted');
    const indexSize = await redis.sCard(`user_sessions:test-user-123`);
    assert(indexSize === 0, 'Session ID removed from user sessions set index');

  } catch (error) {
    console.error('Test Suite encountered an error:', error);
    failedCount++;
  } finally {
    await redis.disconnect();
    console.log('\n--- TEST SUITE COMPLETE ---');
    console.log(`Passed: ${passedCount} tests`);
    console.log(`Failed: ${failedCount} tests`);
    
    if (failedCount > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

runTests();
