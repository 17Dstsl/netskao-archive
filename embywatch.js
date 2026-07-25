"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testEmbyConnection = testEmbyConnection;
exports.runEmbywatch = runEmbywatch;
const undici_1 = require("undici");
const node_dns_1 = require("node:dns");
const database_1 = require("../db/database");
const checkin_1 = require("./checkin");
// Per-username cache of the expanded device name. Persisting it keeps random
// tokens (e.g. {word:4}) stable across runs; we only re-expand when the template
// changes (captured by `sig`). Keyed by Emby username since {username} varies.
const DEVICE_NAMES_KEY = 'emby_device_names';
function readDeviceNames() {
    try {
        const row = database_1.db.prepare('SELECT value FROM settings WHERE key = ?').get(DEVICE_NAMES_KEY);
        if (!row?.value)
            return {};
        return JSON.parse(row.value);
    }
    catch {
        return {};
    }
}
function saveDeviceName(username, entry) {
    const map = readDeviceNames();
    map[username] = entry;
    database_1.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(DEVICE_NAMES_KEY, JSON.stringify(map));
}
// Expand template variables in the device name. {username} is the Emby account
// username for the job; random tokens ({word:N}, {num:N}, {alpha:N}, {uuid})
// come from expandCommand. The expanded value is persisted per username so random
// tokens stay stable across runs, and is only re-rolled when the template changes.
function resolveDeviceName(template, username) {
    if (!template.includes('{'))
        return template;
    const sig = template;
    const cached = readDeviceNames()[username];
    if (cached && cached.sig === sig)
        return cached.deviceName;
    const deviceName = (0, checkin_1.expandCommand)(template, { username });
    saveDeviceName(username, { sig, deviceName });
    return deviceName;
}
// Forces IPv4-only DNS resolution so Happy Eyeballs doesn't waste the connect
// timeout on broken IPv6 routes in container environments.
const ipv4Agent = new undici_1.Agent({
    connect: { lookup: (hostname, opts, cb) => (0, node_dns_1.lookup)(hostname, { ...opts, family: 4 }, cb) },
});
const DEFAULT_UA = 'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0';
const PROGRESS_INTERVAL_S = 30;
// Emby uses 100-nanosecond ticks (same as .NET TimeSpan)
const TICKS_PER_SECOND = 10000000;
function getSetting(key) {
    const row = database_1.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value;
}
// Emby's dashboard shows the session's app name/version from the Client and
// Version fields of X-Emby-Authorization, not the HTTP User-Agent. Derive them
// from the chosen UA so a custom preset (e.g. "CapyPlayer/1.0") is reflected in
// the Emby backend instead of a hardcoded client name.
function parseUaClient(ua) {
    const match = /^([^/\s]+)\/([^\s(]+)/.exec(ua.trim());
    if (match?.[1] && match?.[2]) {
        return { client: match[1], version: match[2] };
    }
    return parseUaClient(DEFAULT_UA);
}
function buildAuthHeader(deviceName, ua, token) {
    // DeviceId must stay URL-safe: some stream proxies embed it in signed
    // redirect URLs and break on whitespace (the display name can keep spaces)
    const deviceId = `${deviceName.replace(/\s+/g, '-')}`;
    const { client, version } = parseUaClient(ua);
    const parts = [
        `MediaBrowser Client="${client}"`,
        `Device="${deviceName}"`,
        `DeviceId="${deviceId}"`,
        `Version="${version}"`,
    ];
    if (token)
        parts.push(`Token="${token}"`);
    return parts.join(', ');
}
async function embyRequest(baseUrl, path, opts) {
    const url = `${baseUrl.replace(/\/$/, '')}${path}`;
    const method = opts.method ?? 'GET';
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': opts.ua,
        'X-Emby-Authorization': buildAuthHeader(opts.deviceName, opts.ua, opts.token),
    };
    const body = opts.body != null ? JSON.stringify(opts.body) : undefined;
    let res;
    try {
        res = await (0, undici_1.fetch)(url, {
            method,
            headers,
            body,
            signal: opts.signal,
            dispatcher: opts.proxyUrl ? new undici_1.ProxyAgent(opts.proxyUrl) : ipv4Agent,
        });
    }
    catch (err) {
        // Network-level failure (ECONNREFUSED, ENOTFOUND, timeout, etc.)
        const cause = err?.cause?.message ?? err?.cause?.code ?? '';
        throw new Error(`Cannot reach Emby server at ${url}${cause ? ` — ${cause}` : ''}`);
    }
    const text = await res.text();
    if (!res.ok) {
        // Try to extract a human-readable message from Emby's JSON error body
        let detail = text;
        try {
            const json = JSON.parse(text);
            if (typeof json.Message === 'string' && json.Message)
                detail = json.Message;
            else if (typeof json.message === 'string' && json.message)
                detail = json.message;
        }
        catch { /* leave detail as raw text */ }
        throw new Error(`Emby ${method} ${path} → ${res.status} ${res.statusText}: ${detail}`);
    }
    return text ? JSON.parse(text) : null;
}
/** Resolves a configured proxy id to its URL from settings, if any. */
function resolveProxyUrl(proxyId) {
    if (!proxyId)
        return undefined;
    try {
        const raw = getSetting('proxies');
        if (!raw)
            return undefined;
        const list = JSON.parse(raw);
        return list.find(p => p.id === proxyId)?.url;
    }
    catch {
        return undefined;
    }
}
// Cap the connection test so the UI isn't stuck waiting on a dead host
const TEST_TIMEOUT_MS = 12000;
/**
 * Authenticates against the Emby server without playing anything, so the UI
 * can confirm the server is reachable and the credentials are valid before a
 * job is saved.
 */
async function testEmbyConnection(serverUrl, opts) {
    const ua = opts.userAgent || getSetting('default_ua') || DEFAULT_UA;
    const deviceName = resolveDeviceName(getSetting('default_device_name') ?? 'Mac', opts.username);
    const proxyUrl = resolveProxyUrl(opts.proxyId);
    try {
        const auth = await embyRequest(serverUrl, '/Users/AuthenticateByName', {
            method: 'POST',
            ua,
            deviceName,
            proxyUrl,
            signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
            body: { Username: opts.username, Pw: opts.password },
        });
        return { ok: true, userName: auth?.User?.Name };
    }
    catch (err) {
        return { ok: false, error: err?.message ?? 'Connection failed' };
    }
}
// Number of random items to try before giving up when verifying playability.
const MAX_PICK_ATTEMPTS = 5;
// Byte range fetched to confirm the media file is actually readable.
const PROBE_RANGE_BYTES = 65535;
/**
 * Fetch the first bytes of a stream URL, as a real player would.
 * A readable file yields 206 (partial) or 200 with body bytes.
 */
async function probeStream(url, opts) {
    try {
        const res = (await (0, undici_1.fetch)(url, {
            method: 'GET',
            headers: {
                'User-Agent': opts.ua,
                Range: `bytes=0-${PROBE_RANGE_BYTES}`,
            },
            dispatcher: opts.proxyUrl ? new undici_1.ProxyAgent(opts.proxyUrl) : ipv4Agent,
        }));
        if (res.status !== 200 && res.status !== 206) {
            await res.body?.cancel?.();
            return false;
        }
        const buf = await res.arrayBuffer();
        return buf.byteLength > 0;
    }
    catch {
        // Network-level failure reaching the stream, treat as unavailable
        return false;
    }
}
/**
 * Ask PlaybackInfo for the stream URL a real client would play. Some servers
 * front Emby with a proxy that only routes this form (e.g. redirecting
 * /videos/{id}/original.{container} to a dedicated stream host) and return
 * errors for the generic /Videos/{id}/stream path.
 */
async function getClientStreamUrl(baseUrl, itemId, mediaSourceId, opts) {
    try {
        const info = await embyRequest(baseUrl, `/Items/${itemId}/PlaybackInfo?UserId=${opts.userId}`, {
            method: 'POST',
            ua: opts.ua,
            token: opts.token,
            deviceName: opts.deviceName,
            proxyUrl: opts.proxyUrl,
            body: { DeviceProfile: { MaxStreamingBitrate: 140000000 } },
        });
        const sources = info?.MediaSources ?? [];
        const source = sources.find(s => s.Id === mediaSourceId) ?? sources[0];
        const path = source?.DirectStreamUrl ?? source?.TranscodingUrl ?? undefined;
        if (!path)
            return undefined;
        if (/^https?:\/\//i.test(path))
            return path;
        return `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
    }
    catch {
        // PlaybackInfo unsupported or failed, caller falls back to the static URL
        return undefined;
    }
}
/**
 * Confirm the media file is actually streamable, mimicking what a real player
 * does: fetch the first bytes of the stream. If the disk/mount is down, Emby
 * can't read the file and returns a non-2xx (or an empty body), so we treat the
 * item as unavailable and avoid reporting a fake watch.
 */
async function isMediaAvailable(baseUrl, itemId, mediaSourceId, opts) {
    // Prefer the URL a real client would play; proxies that offload streaming
    // to another host often only route this form
    const clientUrl = await getClientStreamUrl(baseUrl, itemId, mediaSourceId, opts);
    if (clientUrl && (await probeStream(clientUrl, opts)))
        return true;
    // Fall back to the generic static stream URL
    const params = new URLSearchParams({
        static: 'true',
        mediaSourceId,
        api_key: opts.token,
    });
    const staticUrl = `${baseUrl.replace(/\/$/, '')}/Videos/${itemId}/stream?${params.toString()}`;
    return probeStream(staticUrl, opts);
}
async function runEmbywatch(serverUrl, config) {
    const ua = config.userAgent ?? getSetting('default_ua') ?? DEFAULT_UA;
    const playDuration = config.playDuration ?? Number(getSetting('default_play_duration') ?? 300);
    const deviceName = resolveDeviceName(getSetting('default_device_name') ?? 'Yamby', config.username);
    const proxyUrl = resolveProxyUrl(config.proxyId);
    // 1. Authenticate
    const auth = await embyRequest(serverUrl, '/Users/AuthenticateByName', {
        method: 'POST',
        ua,
        deviceName,
        proxyUrl,
        body: { Username: config.username, Pw: config.password },
    });
    const token = auth.AccessToken;
    const userId = auth.User.Id;
    console.log(`[embywatch] Authenticated as "${auth.User.Name}" on ${serverUrl}`);
    // 2. Pick a random video, verifying it's actually streamable before use.
    // When the disk is down the metadata item still exists, so without this
    // check we'd report a watch for a file no real client could play.
    const verifyPlayable = config.verifyPlayable !== false;
    const attempts = verifyPlayable ? MAX_PICK_ATTEMPTS : 1;
    let item;
    let itemId = '';
    let mediaSourceId = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const items = await embyRequest(serverUrl, `/Users/${userId}/Items?SortBy=Random&Limit=1&IncludeItemTypes=Episode,Movie&Recursive=true&Fields=MediaSources,RunTimeTicks`, { ua, token, deviceName, proxyUrl });
        if (!items.Items?.length)
            throw new Error('No playable items found on Emby server');
        const candidate = items.Items[0];
        const candidateId = candidate.Id;
        const candidateSourceId = candidate.MediaSources?.[0]?.Id ?? candidateId;
        if (!verifyPlayable || (await isMediaAvailable(serverUrl, candidateId, candidateSourceId, { token, ua, userId, deviceName, proxyUrl }))) {
            item = candidate;
            itemId = candidateId;
            mediaSourceId = candidateSourceId;
            break;
        }
        console.warn(`[embywatch] "${candidate.Name}" is not streamable (attempt ${attempt}/${attempts}) — trying another item`);
    }
    if (!item) {
        throw new Error('No streamable items found on Emby server — media may be offline (disk down); skipped reporting');
    }
    const playSessionId = `bemby-${Date.now()}`;
    // 3. Calculate start position: random 5-10% into the episode
    const runtimeSeconds = item.RunTimeTicks ? Math.floor(item.RunTimeTicks / TICKS_PER_SECOND) : 0;
    const startPct = 0.05 + Math.random() * 0.05;
    const startSeconds = runtimeSeconds > 0 ? Math.floor(runtimeSeconds * startPct) : 0;
    const startTicks = startSeconds * TICKS_PER_SECOND;
    // 4. Actual watch duration: playDuration + 0-10% random extra
    const actualDuration = Math.floor(playDuration * (1 + Math.random() * 0.10));
    // Cap so we don't overshoot the end of the episode
    const maxWatchable = runtimeSeconds > 0 ? Math.max(0, Math.floor(runtimeSeconds * 0.97) - startSeconds) : Infinity;
    const watchDuration = maxWatchable < Infinity ? Math.min(actualDuration, maxWatchable) : actualDuration;
    const endSeconds = startSeconds + watchDuration;
    const endTicks = endSeconds * TICKS_PER_SECOND;
    console.log(`[embywatch] Watching "${item.Name}" (${item.Type}) from ${startSeconds}s, duration ${watchDuration}s`);
    // 5. Report playback started (from the calculated start position)
    await embyRequest(serverUrl, '/Sessions/Playing', {
        method: 'POST',
        ua,
        token,
        deviceName,
        proxyUrl,
        body: {
            ItemId: itemId,
            MediaSourceId: mediaSourceId,
            PlaySessionId: playSessionId,
            PositionTicks: startTicks,
            IsPaused: false,
            CanSeek: true,
        },
    });
    // 6. Send progress every PROGRESS_INTERVAL_S seconds, offset from start position
    let elapsed = 0;
    while (elapsed < watchDuration) {
        const wait = Math.min(PROGRESS_INTERVAL_S, watchDuration - elapsed);
        await new Promise(r => setTimeout(r, wait * 1000));
        elapsed += wait;
        await embyRequest(serverUrl, '/Sessions/Playing/Progress', {
            method: 'POST',
            ua,
            token,
            deviceName,
            proxyUrl,
            body: {
                ItemId: itemId,
                MediaSourceId: mediaSourceId,
                PlaySessionId: playSessionId,
                PositionTicks: startTicks + elapsed * TICKS_PER_SECOND,
                IsPaused: false,
            },
        });
    }
    // 7. Report stopped at the final position
    await embyRequest(serverUrl, '/Sessions/Playing/Stopped', {
        method: 'POST',
        ua,
        token,
        deviceName,
        proxyUrl,
        body: {
            ItemId: itemId,
            MediaSourceId: mediaSourceId,
            PlaySessionId: playSessionId,
            PositionTicks: endTicks,
        },
    });
    // 8. Optionally mark the item as watched (enabled by default)
    let markedWatched = false;
    if (config.markWatched !== false) {
        try {
            await embyRequest(serverUrl, `/Users/${userId}/PlayedItems/${itemId}`, {
                method: 'POST',
                ua,
                token,
                deviceName,
                proxyUrl,
            });
            markedWatched = true;
        }
        catch (e) {
            console.warn('[embywatch] Failed to mark item as watched:', e);
        }
    }
    console.log(`[embywatch] Session complete for "${item.Name}" — marked watched: ${markedWatched}`);
    return {
        itemType: item.Type ?? 'Unknown',
        title: item.Name ?? 'Unknown',
        seriesName: item.SeriesName,
        seasonNumber: item.ParentIndexNumber,
        episodeNumber: item.IndexNumber,
        runtimeSeconds,
        startSeconds,
        endSeconds,
        watchedSeconds: watchDuration,
        markedWatched,
    };
}
