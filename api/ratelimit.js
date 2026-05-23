// Simple in-memory rate limiter
// Limits each IP to 30 requests per hour per endpoint

const requests = new Map();

export function rateLimit(ip, endpoint, limit = 30) {
    const key = `${ip}:${endpoint}`;
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour

    if (!requests.has(key)) {
        requests.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: limit - 1 };
    }

    const record = requests.get(key);

    // Reset if window has passed
    if (now > record.resetAt) {
        requests.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: limit - 1 };
    }

    // Increment count
    record.count++;

    if (record.count > limit) {
        return {
            allowed: false,
            remaining: 0,
            resetIn: Math.ceil((record.resetAt - now) / 60000)
        };
    }

    return { allowed: true, remaining: limit - record.count };
}
