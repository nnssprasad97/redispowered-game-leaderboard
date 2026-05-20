import { createClient } from 'redis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

async function run() {
  const client = createClient({ url: redisUrl });
  await client.connect();
  console.log('Connected to Redis for memory analysis...');

  const report = {
    hash: {},
    largeZset: {},
    comparison: {}
  };

  // 1. Session Hash Analysis
  const sessionKey = 'session:analysis-test-id';
  await client.del(sessionKey);
  await client.hSet(sessionKey, {
    userId: 'player-omega-12345',
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    ipAddress: '192.168.1.150',
    deviceType: 'mobile-ios-safari'
  });
  
  report.hash.encoding = await client.objectEncoding(sessionKey);
  report.hash.memory = await client.memoryUsage(sessionKey);
  
  console.log(`\n--- Hash Analysis (session) ---`);
  console.log(`Encoding: ${report.hash.encoding}`);
  console.log(`Memory Usage: ${report.hash.memory} bytes`);

  // 2. Large Sorted Set (100k players) Seeding & Analysis
  const largeZsetKey = 'leaderboard:global';
  console.log('\nSeeding 100,000 players into leaderboard:global...');
  
  // Clear previous leaderboard
  await client.del(largeZsetKey);
  
  const batchSize = 5000;
  const totalPlayers = 100000;
  
  for (let i = 0; i < totalPlayers; i += batchSize) {
    const batch = [];
    for (let j = 0; j < batchSize; j++) {
      const playerId = `player-${i + j}`;
      const score = Math.floor(Math.random() * 10000);
      batch.push({ score, value: playerId });
    }
    await client.zAdd(largeZsetKey, batch);
    if ((i + batchSize) % 20000 === 0) {
      console.log(`Seeded ${i + batchSize} players...`);
    }
  }

  report.largeZset.encoding = await client.objectEncoding(largeZsetKey);
  report.largeZset.memory = await client.memoryUsage(largeZsetKey);
  report.largeZset.cardinality = await client.zCard(largeZsetKey);

  console.log(`\n--- Large Sorted Set (100k players) ---`);
  console.log(`Cardinality: ${report.largeZset.cardinality}`);
  console.log(`Encoding: ${report.largeZset.encoding}`);
  console.log(`Memory Usage: ${report.largeZset.memory} bytes (~${(report.largeZset.memory / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Average Memory Per Player: ${(report.largeZset.memory / totalPlayers).toFixed(1)} bytes`);

  // 3. Comparison of Sorted Set before and after forcing skiplist encoding
  console.log('\nRunning comparative analysis on Sorted Set (100 players)...');
  
  const zset100ListpackKey = 'leaderboard:comparison:listpack';
  const zset100SkiplistKey = 'leaderboard:comparison:skiplist';
  
  await client.del(zset100ListpackKey);
  await client.del(zset100SkiplistKey);
  
  // Default Config (typically 128 max entries for listpack/ziplist)
  // Let's seed 100 players under default configuration
  const compPlayers = [];
  for (let k = 0; k < 100; k++) {
    compPlayers.push({ score: k * 10, value: `comp-player-${k}` });
  }
  
  await client.zAdd(zset100ListpackKey, compPlayers);
  report.comparison.listpack = {
    encoding: await client.objectEncoding(zset100ListpackKey),
    memory: await client.memoryUsage(zset100ListpackKey)
  };
  
  // Now change configurations to force skiplist (set max entries threshold to 10)
  let configKey = 'zset-max-listpack-entries';
  try {
    await client.configSet('zset-max-listpack-entries', '10');
  } catch (err) {
    // Fallback for older Redis versions
    try {
      await client.configSet('zset-max-ziplist-entries', '10');
      configKey = 'zset-max-ziplist-entries';
    } catch (err2) {
      console.warn('Could not set config, running comparison with what is supported', err2.message);
    }
  }

  // Create another set of 100 players under the new config
  await client.zAdd(zset100SkiplistKey, compPlayers);
  report.comparison.skiplist = {
    encoding: await client.objectEncoding(zset100SkiplistKey),
    memory: await client.memoryUsage(zset100SkiplistKey)
  };

  // Restore configurations
  try {
    await client.configSet(configKey, '128');
  } catch (err) {
    console.warn('Could not restore config:', err.message);
  }

  console.log(`\n--- Encoding Comparison (100 players) ---`);
  console.log(`Listpack/Ziplist Encoding:`);
  console.log(`  Encoding: ${report.comparison.listpack.encoding}`);
  console.log(`  Memory Usage: ${report.comparison.listpack.memory} bytes`);
  
  console.log(`Skiplist Encoding:`);
  console.log(`  Encoding: ${report.comparison.skiplist.encoding}`);
  console.log(`  Memory Usage: ${report.comparison.skiplist.memory} bytes`);
  
  const overhead = report.comparison.skiplist.memory - report.comparison.listpack.memory;
  const ratio = (report.comparison.skiplist.memory / report.comparison.listpack.memory).toFixed(2);
  console.log(`Memory Overhead of Skiplist: +${overhead} bytes (${ratio}x size of listpack)`);

  // Write findings to MEMORY_ANALYSIS.md
  const analysisContent = `# Redis Memory Analysis Report

This document records the memory consumption characteristics of Redis data structures (Hashes, Sorted Sets) used in the Trivia Arena project. Tests were run programmatically against a Redis 7 instance.

## 1. Memory Usage of a Session Hash
A user session is represented as a Redis Hash storing key fields: \`userId\`, \`createdAt\`, \`lastActive\`, \`ipAddress\`, and \`deviceType\`.

- **Key Pattern**: \`session:{sessionId}\`
- **Object Encoding**: \`${report.hash.encoding}\`
- **Total Memory Usage**: \`${report.hash.memory} bytes\`
- **Description**: Redis encodes small Hashes using \`listpack\` (or \`ziplist\` in Redis < 7). This represents the data as a contiguous, space-optimized byte array, drastically minimizing pointer overhead.

## 2. Memory Usage of a Large Sorted Set (100k Players)
The global leaderboard stores 100,000 unique players and their scores in a single Sorted Set.

- **Key**: \`leaderboard:global\`
- **Cardinality**: \`${report.largeZset.cardinality.toLocaleString()} members\`
- **Object Encoding**: \`${report.largeZset.encoding}\`
- **Total Memory Usage**: \`${report.largeZset.memory.toLocaleString()} bytes\` (~${(report.largeZset.memory / 1024 / 1024).toFixed(2)} MB)
- **Average Memory Per Player**: \`${(report.largeZset.memory / totalPlayers).toFixed(1)} bytes/member\`
- **Description**: With 100k members, the data structure exceeds the listpack entries threshold (default 128) and is promoted to a \`skiplist\` encoding. The skiplist is a combination of a hash table (for O(1) score lookups by value) and a skip list (for O(log(N)) range queries), which uses significantly more memory but guarantees high performance.

## 3. Listpack (Ziplist) vs. Skiplist Comparative Analysis (100 Players)
We created two Sorted Sets of exactly **100 players** each to compare their memory footprints before and after forcing a skiplist encoding via Redis configuration changes.

| Configuration | Object Encoding | Memory Usage (Bytes) | Overhead Factor |
| :--- | :--- | :--- | :--- |
| **Listpack (Ziplist)** | \`${report.comparison.listpack.encoding}\` | \`${report.comparison.listpack.memory}\` | 1.0x (Baseline) |
| **Skiplist (Forced)** | \`${report.comparison.skiplist.encoding}\` | \`${report.comparison.skiplist.memory}\` | \`${ratio}x\` |

- **Net Skiplist Overhead**: \`+${overhead} bytes\`
- **Analysis**:
  - The **Listpack** encoding stores the entries in a compact, linear array, sorting them on insertion. This is highly memory-efficient but costs $O(N)$ for insertions and updates if $N$ becomes large.
  - The **Skiplist** encoding instantiates the dual hash table and skip list structures, which uses pointers for nodes across multiple levels. This results in a **${ratio}x increase in memory consumption** for the same 100 players.
  - **Trade-off**: For small leaderboards (<128 items), Listpack is extremely memory-efficient with negligible performance impact. For larger sets, Skiplist is required to ensure logarithmic time complexity ($O(\log N)$) for insertion, ranking, and range retrievals.
`;

  fs.writeFileSync(path.join(__dirname, '..', 'MEMORY_ANALYSIS.md'), analysisContent);
  console.log('\nMEMORY_ANALYSIS.md has been generated successfully!');

  // Clean up comparison keys
  await client.del(zset100ListpackKey);
  await client.del(zset100SkiplistKey);
  
  await client.disconnect();
}

run().catch(console.error);
