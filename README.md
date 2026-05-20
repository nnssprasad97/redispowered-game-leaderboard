# Redis-Powered Trivia Game & Real-Time Leaderboard

Welcome to the **Redis Trivia Arena**, a high-performance, real-time quiz game backend and live dashboard powered by advanced Redis data structures and atomic operations.

This application demonstrates how to use Redis beyond simple caching—leveraging **Hashes** for sliding sessions, **Sets** for indexing, **Sorted Sets** for instant O(log N) leaderboard indexing, **Pub/Sub** for message propagation, and **Lua Scripting** for transaction-free atomic operations.

---

## 🚀 Getting Started

### 1. Prerequisites
- [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/)
- OR Node.js (v20+) and local Redis (v7+) if running without containers.

### 2. Environment Setup
Rename or copy `.env.example` to `.env` in the project root:
```bash
cp .env.example .env
```
Ensure you have configured the following variables in `.env`:
*   `REDIS_URL`: The Redis connection string (e.g. `redis://redis:6379` inside Docker, or `redis://localhost:6379` for local development).
*   `API_PORT`: The port on which the Express server runs (default: `3000`).

### 3. Running with Docker Compose (Recommended)
To build and start both the Express API container and the Redis container:
```bash
docker-compose up --build
```
Both containers will start and perform self-checks. The application will be accessible at:
👉 **[http://localhost:3000](http://localhost:3000)**

### 4. Running Locally
If you prefer running directly on your host machine:
1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Start the development server with live reload:
    ```bash
    npm run dev
    ```
3.  Open `http://localhost:3000` in your browser.

---

## 🏗️ Architecture & Component Breakdown

```
                    +------------------------------------+
                    |         Browser Client             |
                    |      (Frontend Dashboard)          |
                    +---------+----------------+---------+
                              |                ^
                REST API Calls|                | SSE Connection
             (Sessions, Quiz) |                | (Live Events)
                              v                |
                    +---------+----------------+---------+
                    |          Game API Server           |
                    |           (Express.js)             |
                    +---------+----------------+---------+
                              |                |
             Execute Lua/ZADD |                | Subscribe
                              v                v
                    +---------+----------------+---------+
                    |             Redis Server           |
                    |     (Data, Pub/Sub Engine)         |
                    +------------------------------------+
```

1.  **Game API Server (Express.js)**: Implements REST routes for player sessions, leaderboard actions, and game submissions. It serves the frontend assets and exposes the SSE client pool.
2.  **Redis Server**:
    *   **Hashes (`session:{id}`)**: Space-optimized storage for active user sessions.
    *   **Sets (`user_sessions:{userId}`)**: Secondary index tracking active session IDs per user.
    *   **Sorted Sets (`leaderboard:global`)**: Scores indexed by player IDs for real-time ranking.
    *   **Sets (`submissions:{gameId}:{roundId}`)**: Tracks who has already submitted answers to prevent duplicates.
    *   **Hashes (`game_round:{gameId}:{roundId}`)**: Holds round timing (`endTime`), `correctAnswer`, and scoring weights.
    *   **Pub/Sub (`game-events`)**: Relays real-time events (`leaderboard_updated`, `answer_submitted`) to SSE handlers.
3.  **Real-Time SSE Stream**: Uses the HTML5 `EventSource` API on the frontend, maintaining a single HTTP connection to push real-time updates as they occur in the Pub/Sub channel.
4.  **Frontend Dashboard**: A premium, dark-themed, glassmorphic dashboard showcasing real-time ranks, player statistics, live event logs, and administrative session termination tools.

---

## ⚡ Atomic Operations & Lua Scripting

In multi-user gaming environments, concurrency issues can easily lead to race conditions. This project ensures **data consistency** by offloading complex check-and-write logic to the Redis server via Lua scripting (`EVAL`).

### Why Lua over other methods?

Normally, to implement "check-then-set" logic (e.g. check if a player already submitted, then update their score), a developer might use:
1.  **Application-level transactions**: Read from database, check in Node.js, then write back. This is highly susceptible to race conditions because multiple requests can read the same stale state concurrently.
2.  **Redis Transactions (`MULTI/EXEC` / `WATCH`)**: These use optimistic locking. If another client modifies a watched key, the transaction fails and the client must retry. Under high concurrency (e.g. thousands of players submitting answers in the same second), this leads to high abort rates and heavy network overhead due to retries.

**The Lua Advantage:**
Redis executes Lua scripts **monolithically and atomically** on a single thread. No other command can run while a script is executing. This guarantees that:
*   No race conditions can occur between reading a key and writing another.
*   Zero network round-trips occur mid-transaction, maximizing throughput.

### Included Lua Scripts

#### 1. Session Creation and Invalidation (`create_session.lua`)
Ensures that when a user creates a new session, all their previous active sessions are instantly cleared.
*   **Keys**: `user_sessions:{userId}`, `session:{newSessionId}`
*   **Operation**: Fetches all old session IDs using `SMEMBERS`, deletes their individual hashes `session:{oldSessionId}`, drops the old set, creates the new session hash with a sliding expiration (`EXPIRE`), and indexes it inside `user_sessions:{userId}`. All of this runs as a single instruction block.

#### 2. Quiz Submission & Processing (`submit_answer.lua`)
Processes a player's answer submission under strict game rules.
*   **Keys**: `game_round:{gameId}:{roundId}`, `submissions:{gameId}:{roundId}`, `leaderboard:global`
*   **Operation**:
    1.  Checks if the round is active by comparing the current timestamp against the round's `endTime`. If expired, returns a `ROUND_EXPIRED` error.
    2.  Checks if the player has already submitted an answer using `SISMEMBER` on the submission tracker set. If true, returns a `DUPLICATE_SUBMISSION` error.
    3.  Records the player's submission with `SADD`.
    4.  Compares the player's answer against the correct answer stored in the round hash. If correct, increments the player's score in the global leaderboard (`ZINCRBY`).
    5.  Returns the updated score and correctness status to the server, which is then broadcasted via Pub/Sub.

---

## 📊 Memory Analysis Findings
See [MEMORY_ANALYSIS.md](MEMORY_ANALYSIS.md) in the project root for details on the memory footprint of different Redis data structures and comparison of listpack vs. skiplist encodings.
Key takeaway: For small datasets, Redis utilizes space-optimized **listpacks** which are up to **5.29x more memory-efficient** than **skiplists**, but skiplists are dynamically promoted at scale to preserve $O(\log N)$ operation speeds.
