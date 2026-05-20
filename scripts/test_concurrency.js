import { createClient } from 'redis';

const API_PORT = process.env.API_PORT || 3000;
const API_URL = `http://localhost:${API_PORT}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function runConcurrencyTests() {
  console.log('=== STARTING REDIS CONCURRENCY & ATOMICITY TEST SUITE ===');
  
  const redis = createClient({ url: REDIS_URL });
  await redis.connect();
  
  // Clean up
  const player1 = 'player-concurrent-1';
  const player2 = 'player-concurrent-2';
  const gameId = 'game-concurrent';
  const roundId = 'round-concurrent';
  
  await redis.zRem('leaderboard:global', [player1, player2]);
  await redis.del(`submissions:${gameId}:${roundId}`);
  await redis.del(`game_round:${gameId}:${roundId}`);

  console.log('\n--- Test 1: High Concurrency Leaderboard Increments (ZINCRBY) ---');
  console.log('Goal: Fire 100 concurrent requests incrementing score by 5 points. Expected final score: 500.');
  
  // Setup baseline
  await redis.zAdd('leaderboard:global', { score: 0, value: player1 });
  
  const incrementRequests = [];
  for (let i = 0; i < 100; i++) {
    incrementRequests.push(
      fetch(`${API_URL}/api/leaderboard/scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: player1, points: 5 })
      })
    );
  }
  
  console.log('Sending 100 concurrent score updates...');
  const incrementResponses = await Promise.all(incrementRequests);
  
  let successfulIncrements = 0;
  for (const res of incrementResponses) {
    if (res.status === 200) {
      successfulIncrements++;
    }
  }
  
  const finalScore = await redis.zScore('leaderboard:global', player1);
  console.log(`Results:`);
  console.log(`- Total requests sent: 100`);
  console.log(`- Requests returning 200 OK: ${successfulIncrements}`);
  console.log(`- Final Score in Redis: ${finalScore}`);
  
  const test1Passed = finalScore === 500 && successfulIncrements === 100;
  if (test1Passed) {
    console.log('✅ TEST 1 PASSED: Leaderboard updates are fully atomic and consistent under concurrency.');
  } else {
    console.error('❌ TEST 1 FAILED: Discrepancy in final score or successful requests.');
  }

  console.log('\n--- Test 2: Atomic Quiz Answer Submission Lua Script ---');
  console.log('Goal: Fire 50 concurrent submissions for the same player. Expected: exactly 1 SUCCESS (200), and 49 DUPLICATE_SUBMISSION errors (400).');
  
  // Seed game round
  await fetch(`${API_URL}/api/admin/rounds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gameId,
      roundId,
      durationSeconds: 30,
      correctAnswer: 'Redis',
      points: 15
    })
  });
  
  // Also baseline player 2 to score 0
  await redis.zAdd('leaderboard:global', { score: 0, value: player2 });
  
  const submitRequests = [];
  for (let i = 0; i < 50; i++) {
    submitRequests.push(
      fetch(`${API_URL}/api/game/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId,
          roundId,
          playerId: player2,
          answer: 'Redis'
        })
      })
    );
  }
  
  console.log('Sending 50 concurrent answer submissions...');
  const submitResponses = await Promise.all(submitRequests);
  
  let successCount = 0;
  let duplicateCount = 0;
  let otherCount = 0;
  
  for (const res of submitResponses) {
    if (res.status === 200) {
      successCount++;
    } else if (res.status === 400) {
      const data = await res.json();
      if (data.code === 'DUPLICATE_SUBMISSION') {
        duplicateCount++;
      } else {
        otherCount++;
      }
    } else {
      otherCount++;
    }
  }
  
  const finalSubmissionsSetSize = await redis.sCard(`submissions:${gameId}:${roundId}`);
  const finalPlayer2Score = await redis.zScore('leaderboard:global', player2);
  
  console.log(`Results:`);
  console.log(`- Total requests sent: 50`);
  console.log(`- Success responses (200 OK): ${successCount}`);
  console.log(`- Duplicate Submission responses (400 Bad Request): ${duplicateCount}`);
  console.log(`- Other error responses: ${otherCount}`);
  console.log(`- Cardinality of submissions Set: ${finalSubmissionsSetSize}`);
  console.log(`- Player score in Redis: ${finalPlayer2Score}`);
  
  const test2Passed = successCount === 1 && duplicateCount === 49 && finalSubmissionsSetSize === 1 && finalPlayer2Score === 15;
  if (test2Passed) {
    console.log('✅ TEST 2 PASSED: The Lua script guarantees strict mutual exclusion and atomicity under concurrency.');
  } else {
    console.error('❌ TEST 2 FAILED: Atomic checks failed.');
  }
  
  await redis.disconnect();
  
  if (test1Passed && test2Passed) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runConcurrencyTests().catch(console.error);
