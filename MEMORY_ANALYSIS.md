# Redis Memory Analysis Report

This document records the memory consumption characteristics of Redis data structures (Hashes, Sorted Sets) used in the Trivia Arena project. Tests were run programmatically against a Redis 7 instance.

## 1. Memory Usage of a Session Hash
A user session is represented as a Redis Hash storing key fields: `userId`, `createdAt`, `lastActive`, `ipAddress`, and `deviceType`.

- **Key Pattern**: `session:{sessionId}`
- **Object Encoding**: `listpack`
- **Total Memory Usage**: `210 bytes`
- **Description**: Redis encodes small Hashes using `listpack` (or `ziplist` in Redis < 7). This represents the data as a contiguous, space-optimized byte array, drastically minimizing pointer overhead.

## 2. Memory Usage of a Large Sorted Set (100k Players)
The global leaderboard stores 100,000 unique players and their scores in a single Sorted Set.

- **Key**: `leaderboard:global`
- **Cardinality**: `1,00,000 members`
- **Object Encoding**: `skiplist`
- **Total Memory Usage**: `94,22,639 bytes` (~8.99 MB)
- **Average Memory Per Player**: `94.2 bytes/member`
- **Description**: With 100k members, the data structure exceeds the listpack entries threshold (default 128) and is promoted to a `skiplist` encoding. The skiplist is a combination of a hash table (for O(1) score lookups by value) and a skip list (for O(log(N)) range queries), which uses significantly more memory but guarantees high performance.

## 3. Listpack (Ziplist) vs. Skiplist Comparative Analysis (100 Players)
We created two Sorted Sets of exactly **100 players** each to compare their memory footprints before and after forcing a skiplist encoding via Redis configuration changes.

| Configuration | Object Encoding | Memory Usage (Bytes) | Overhead Factor |
| :--- | :--- | :--- | :--- |
| **Listpack (Ziplist)** | `listpack` | `1934` | 1.0x (Baseline) |
| **Skiplist (Forced)** | `skiplist` | `10240` | `5.29x` |

- **Net Skiplist Overhead**: `+8306 bytes`
- **Analysis**:
  - The **Listpack** encoding stores the entries in a compact, linear array, sorting them on insertion. This is highly memory-efficient but costs $O(N)$ for insertions and updates if $N$ becomes large.
  - The **Skiplist** encoding instantiates the dual hash table and skip list structures, which uses pointers for nodes across multiple levels. This results in a **5.29x increase in memory consumption** for the same 100 players.
  - **Trade-off**: For small leaderboards (<128 items), Listpack is extremely memory-efficient with negligible performance impact. For larger sets, Skiplist is required to ensure logarithmic time complexity ($O(log N)$) for insertion, ranking, and range retrievals.
