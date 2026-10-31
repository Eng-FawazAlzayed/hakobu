package app.hakobu.core

import kotlinx.coroutines.delay
import kotlin.math.min

/** Token bucket shared by every connection for the global speed limit. 0 = unlimited. */
class RateLimiter(bytesPerSec: Long = 0) {
    private var rate = bytesPerSec
    private var tokens = 0.0
    private var last = System.nanoTime()

    @Synchronized
    fun setRate(bytesPerSec: Long) {
        rate = bytesPerSec
        tokens = 0.0
    }

    suspend fun take(n: Int) {
        while (true) {
            val waitMs = synchronized(this) {
                if (rate <= 0) return
                val now = System.nanoTime()
                tokens = min(rate.toDouble(), tokens + (now - last) / 1e9 * rate)
                last = now
                if (tokens > 0) {
                    tokens -= n // may go negative; the debt is paid back before the next chunk
                    return
                }
                min(250.0, -tokens / rate * 1000 + 10).toLong()
            }
            delay(waitMs)
        }
    }
}
