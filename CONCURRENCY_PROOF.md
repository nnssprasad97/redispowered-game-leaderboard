# Redis Concurrency & Atomicity Proof

To guarantee that the backend is production-ready and free from race conditions under extreme load, we implemented and ran a programmatic concurrency test suite at [scripts/test_concurrency.js](file:///c:/Users/nnssp/Desktop/redispowered-game-leaderboard/scripts/test_concurrency.js). 

This document records the design and verified console results of these stress tests.

---

## 🧪 Test Case 1: Concurrent Leaderboard Increments
*   **Goal**: Submit 100 HTTP score increment requests to `/api/leaderboard/scores` *simultaneously* for a single player. Each request increments the player's score by 5 points.
*   **Expected Behavior**: All 100 requests must succeed with `200 OK` status, and the final score stored in Redis must be exactly **500 points** (100 updates * 5 points).
*   **Significance**: Proves that Redis's built-in `ZINCRBY` (Sorted Set increment) operation is fully thread-safe and executes atomically, without losing updates due to read-write race conditions.

### Verified Results:
```text
--- Test 1: High Concurrency Leaderboard Increments (ZINCRBY) ---
Goal: Fire 100 concurrent requests incrementing score by 5 points. Expected final score: 500.
Sending 100 concurrent score updates...
Results:
- Total requests sent: 100
- Requests returning 200 OK: 100
- Final Score in Redis: 500
✅ TEST 1 PASSED: Leaderboard updates are fully atomic and consistent under concurrency.
```

---

## 🧪 Test Case 2: Atomic Quiz Answer Submission & Exact-Once Scoring
*   **Goal**: Submit 50 HTTP quiz submissions to `/api/game/submit` *simultaneously* for the same player, answering the exact same active trivia round. Each correct answer is worth 15 points.
*   **Expected Behavior**:
    *   **Exactly 1** request must return a `200 OK` (success) code, representing the recorded submission.
    *   **Exactly 49** requests must return `400 Bad Request` with error code `DUPLICATE_SUBMISSION`, indicating they were caught by the double-submit check.
    *   The player's score in the leaderboard must increase by **exactly 15 points** (not $50 \times 15 = 750$ points!).
    *   The Redis set index tracking round submissions must have a cardinality of **exactly 1**.
*   **Significance**: Proves that our custom Lua script (`submit_answer.lua`) executes monolithically and atomically. It prevents multiple concurrent threads from reading the state ("player has not submitted yet") before the write completes, guaranteeing exact-once processing.

### Verified Results:
```text
--- Test 2: Atomic Quiz Answer Submission Lua Script ---
Goal: Fire 50 concurrent submissions for the same player. Expected: exactly 1 SUCCESS (200), and 49 DUPLICATE_SUBMISSION errors (400).
Sending 50 concurrent answer submissions...
Results:
- Total requests sent: 50
- Success responses (200 OK): 1
- Duplicate Submission responses (400 Bad Request): 49
- Other error responses: 0
- Cardinality of submissions Set: 1
- Player score in Redis: 15
✅ TEST 2 PASSED: The Lua script guarantees strict mutual exclusion and atomicity under concurrency.
```

---

## 💡 Rationale: Why standard application-level locks or transactions fail
If we had coded this logic in Javascript rather than a Redis Lua script, the execution sequence would look like this under high concurrency:
1.  **Thread A** queries Redis: "Has Player X submitted for Round Y?" -> Redis replies: "No".
2.  **Thread B** queries Redis: "Has Player X submitted for Round Y?" -> Redis replies: "No".
3.  **Thread A** writes: "Player X has submitted" and increments score.
4.  **Thread B** writes: "Player X has submitted" and increments score.

This results in a **double-score bug** where a player gets credited twice. 

By utilizing **Lua Scripting**, Redis compiles and runs the script in a single blocking block on its single event-loop thread. Thread B's execution is forced to wait until Thread A's script is fully completed. When Thread B's script finally runs, the check immediately finds Player X's record in the submission set and returns a `DUPLICATE_SUBMISSION` error.
