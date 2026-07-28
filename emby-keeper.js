WidgetMetadata = {
  id: "embyKeeper",
  title: "Emby 自动保号",
  version: "2.4.0",
  requiredVersion: "0.0.1",
  author: "Codex",
  description: "把“保存配置”添加到首页；首页加载时按间隔自动检查，并显示最近的保号观看记录。",
  site: "https://emby.media",
  detailCacheDuration: 0,
  modules: [
    {
      id: "saveConfig",
      title: "保存配置",
      functionName: "saveConfig",
      description: "配置、自动检查和立即测试都在这里；首页会保留最近的观看记录。",
      cacheDuration: 0,
      params: [
        {
          name: "serverUrl",
          title: "Emby 服务器地址",
          type: "input",
          description: "填写完整地址，末尾不需要斜杠。",
          placeholders: [
            { title: "https://example.com", value: "https://example.com" },
            { title: "http://192.168.1.2:8096", value: "http://192.168.1.2:8096" },
          ],
        },
        { name: "username", title: "Emby 用户名", type: "input" },
        {
          name: "password",
          title: "Emby 密码",
          type: "input",
          description: "ForwardWidget 当前是普通输入框，请只在自己的设备上保存。",
        },
        {
          name: "libraryName",
          title: "资源库名称",
          type: "input",
          description: "留空代表全部电影/剧集库；填写后按名称模糊匹配。",
          placeholders: [
            { title: "留空：全部资源库", value: "" },
            { title: "例如：动画", value: "动画" },
            { title: "例如：Movies", value: "Movies" },
          ],
        },
        {
          name: "intervalHours",
          title: "每隔多少小时执行",
          type: "input",
          value: "168",
          description: "首页加载时检查；未到间隔只显示状态，不执行保号。",
        },
        {
          name: "intervalJitterHours",
          title: "间隔随机延迟（小时）",
          type: "input",
          value: "0",
          description: "下次执行时间额外增加 0 到该值之间的随机小时数；0 表示关闭。",
        },
        {
          name: "playDuration",
          title: "播放时长（秒）",
          type: "input",
          value: "300",
          description: "从影片 5-10% 位置开始，上报时长额外随机增加 0-10%。",
        },
        {
          name: "markWatched",
          title: "播放后标记已看",
          type: "enumeration",
          value: "true",
          enumOptions: [
            { title: "是", value: "true" },
            { title: "否", value: "false" },
          ],
        },
        {
          name: "executionMode",
          title: "执行方式",
          type: "enumeration",
          value: "auto",
          description: "立即执行只触发一次；需要再次测试时，先切回自动并保存，再重新选择立即执行。",
          enumOptions: [
            { title: "按间隔自动检查", value: "auto" },
            { title: "立即执行一次", value: "once" },
          ],
        },
        {
          name: "advanced",
          title: "高级设置",
          type: "enumeration",
          value: "hide",
          enumOptions: [
            { title: "隐藏", value: "hide" },
            { title: "显示", value: "show" },
          ],
        },
        {
          name: "deviceName",
          title: "设备名称",
          type: "input",
          value: "Mac",
          description: "显示在 Emby 后台的设备名。",
          belongTo: { paramName: "advanced", value: ["show"] },
        },
        {
          name: "maxRetries",
          title: "最大重试次数",
          type: "input",
          value: "3",
          description: "随机资源为空时换库或换片重试。",
          belongTo: { paramName: "advanced", value: ["show"] },
        },
      ],
    },
  ],
};

const TICKS_PER_SECOND = 10000000;
const STORE_PREFIX = "embyKeeper";

function cleanBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`请填写${label}`);
  return text;
}

function normalizeConfig(params) {
  const config = {
    serverUrl: cleanBaseUrl(requireText(params.serverUrl, "Emby 服务器地址")),
    username: requireText(params.username, "Emby 用户名"),
    password: String(params.password || ""),
    libraryName: String(params.libraryName || "").trim(),
    intervalHours: String(numberParam(params.intervalHours, 168, 1)),
    intervalJitterHours: String(numberParam(params.intervalJitterHours, 0, 0)),
    playDuration: String(numberParam(params.playDuration, 300, 1)),
    markWatched: boolParam(params.markWatched, true) ? "true" : "false",
    executionMode: String(params.executionMode || "auto") === "once" ? "once" : "auto",
    deviceName: String(params.deviceName || "Mac").trim() || "Mac",
    maxRetries: String(numberParam(params.maxRetries, 3, 1)),
  };
  if (!/^https?:\/\//i.test(config.serverUrl)) {
    throw new Error("Emby 服务器地址需要以 http:// 或 https:// 开头");
  }
  if (!config.password) throw new Error("请填写Emby 密码");
  return config;
}

function numberParam(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function boolParam(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function getDeviceName(config) {
  return String(config.deviceName || "Mac").trim() || "Mac";
}

function deviceId(config) {
  return getDeviceName(config).replace(/\s+/g, "-");
}

function authHeader(config, token) {
  const parts = [
    'MediaBrowser Client="Forward"',
    `Device="${getDeviceName(config)}"`,
    `DeviceId="${deviceId(config)}"`,
    'Version="1.0.0"',
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(", ");
}

function embyHeaders(config, token) {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Emby-Client": "Forward",
    "X-Emby-Device-Name": getDeviceName(config),
    "X-Emby-Device-Id": deviceId(config),
    "X-Emby-Client-Version": "1.0.0",
    "X-Emby-Authorization": authHeader(config, token),
  };
}

function urlFor(config, path) {
  return `${config.serverUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function embyGet(config, path, token) {
  const res = await Widget.http.get(urlFor(config, path), {
    headers: embyHeaders(config, token),
  });
  return res.data;
}

async function embyPost(config, path, body, token) {
  const res = await Widget.http.post(urlFor(config, path), body || {}, {
    headers: embyHeaders(config, token),
  });
  return res.data;
}

async function authenticate(config) {
  return embyPost(config, "/Users/AuthenticateByName", {
    Username: config.username,
    Pw: config.password,
  });
}

async function getLibraries(config, auth) {
  const data = await embyGet(config, `/Users/${auth.User.Id}/Views`, auth.AccessToken);
  const items = data.Items || [];
  return items.filter((item) => {
    const type = String(item.CollectionType || "");
    return type === "movies" || type === "tvshows" || type === "boxsets" || type === "";
  });
}

function filterLibraries(libraries, config) {
  const keyword = String(config.libraryName || "").trim().toLowerCase();
  if (!keyword) return libraries;
  return libraries.filter((library) => String(library.Name || "").toLowerCase().includes(keyword));
}

function pickOne(items) {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function storageKey(config) {
  const server = cleanBaseUrl(config.serverUrl).replace(/^https?:\/\//i, "");
  const library = String(config.libraryName || "all").trim() || "all";
  return `${STORE_PREFIX}:${server}:${config.username}:${library}`;
}

function nextDueKey(config) {
  return `${storageKey(config)}:${config.intervalHours}:${config.intervalJitterHours}:nextDue`;
}

function historyKey(config) {
  return `${storageKey(config)}:history`;
}

function forceOnceKey(config) {
  return `${storageKey(config)}:forceOnceConsumed`;
}

function loadHistory(config) {
  const raw = Widget.storage.get(historyKey(config));
  if (!raw) return [];
  try {
    const records = JSON.parse(raw);
    return Array.isArray(records) ? records : [];
  } catch (_) {
    return [];
  }
}

function saveHistoryRecord(config, record) {
  const records = [record, ...loadHistory(config)].slice(0, 20);
  Widget.storage.set(historyKey(config), JSON.stringify(records));
}

function historyItems(config) {
  return loadHistory(config).slice(0, 10).map((record) => statusItem(
    `history:${record.time}:${record.itemId}`,
    `观看记录：${record.title}`,
    [
      `账号：${record.account}`,
      `资源库：${record.library}`,
      `模拟观看：${record.watchedSeconds} 秒`,
      `播放区间：${record.startSeconds}s - ${record.endSeconds}s`,
      `标记已看：${record.markWatched ? "是" : "否"}`,
      `执行时间：${formatTime(record.time)}`,
    ].join("\n"),
    record.posterPath ? { posterPath: record.posterPath, backdropPath: record.posterPath } : {}
  ));
}

function formatTime(ms) {
  if (!ms) return "从未执行";
  try {
    return new Date(ms).toLocaleString();
  } catch (_) {
    return String(ms);
  }
}

function statusItem(id, title, description, extra) {
  return Object.assign({
    id,
    type: "url",
    title,
    description,
    link: id,
  }, extra || {});
}

function itemImageUrl(config, item, token) {
  if (!item || !item.Id) return undefined;
  const tag = item.ImageTags && item.ImageTags.Primary
    ? `&tag=${encodeURIComponent(item.ImageTags.Primary)}`
    : "";
  return `${config.serverUrl}/Items/${item.Id}/Images/Primary?fillHeight=450&fillWidth=300&quality=90&api_key=${encodeURIComponent(token)}${tag}`;
}

async function getRandomItem(config, auth, libraries) {
  const selected = filterLibraries(libraries, config);
  if (!selected.length) {
    const names = libraries.map((library) => library.Name).filter(Boolean).join(" / ");
    throw new Error(`没有匹配的资源库。当前可用资源库：${names || "无"}`);
  }

  const retries = numberParam(config.maxRetries, 3, 1);
  for (let i = 0; i < retries; i++) {
    const library = pickOne(selected);
    const query = [
      "SortBy=Random",
      "Limit=1",
      "Recursive=true",
      "IncludeItemTypes=Episode,Movie",
      "Fields=MediaSources,RunTimeTicks,SeriesName,ParentIndexNumber,IndexNumber,ImageTags",
      `ParentId=${encodeURIComponent(library.Id)}`,
    ].join("&");
    const data = await embyGet(config, `/Users/${auth.User.Id}/Items?${query}`, auth.AccessToken);
    const item = data.Items && data.Items[0];
    if (item) return { library, item };
  }

  throw new Error("没有找到可模拟观看的影片。可以清空资源库名称，或提高最大重试次数。");
}

async function reportPlayback(config, auth, item) {
  const token = auth.AccessToken;
  const playDuration = numberParam(config.playDuration, 300, 1);
  const runtimeSeconds = item.RunTimeTicks ? Math.floor(item.RunTimeTicks / TICKS_PER_SECOND) : 0;
  const startRatio = 0.05 + Math.random() * 0.05;
  const startSeconds = runtimeSeconds > 0 ? Math.floor(runtimeSeconds * startRatio) : 0;
  const randomExtra = Math.floor(playDuration * Math.random() * 0.1);
  const desiredWatchSeconds = playDuration + randomExtra;
  const maxWatchSeconds = runtimeSeconds > 0
    ? Math.max(1, Math.floor(runtimeSeconds * 0.97) - startSeconds)
    : desiredWatchSeconds;
  const watchedSeconds = Math.min(desiredWatchSeconds, maxWatchSeconds);
  const endSeconds = startSeconds + watchedSeconds;
  const mediaSourceId = item.MediaSources && item.MediaSources[0] && item.MediaSources[0].Id
    ? item.MediaSources[0].Id
    : item.Id;
  const playSessionId = `forward-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  await embyPost(config, "/Sessions/Playing", {
    ItemId: item.Id,
    MediaSourceId: mediaSourceId,
    PlaySessionId: playSessionId,
    PositionTicks: startSeconds * TICKS_PER_SECOND,
    IsPaused: false,
    CanSeek: true,
  }, token);

  await embyPost(config, "/Sessions/Playing/Progress", {
    ItemId: item.Id,
    MediaSourceId: mediaSourceId,
    PlaySessionId: playSessionId,
    PositionTicks: endSeconds * TICKS_PER_SECOND,
    IsPaused: false,
  }, token);

  await embyPost(config, "/Sessions/Playing/Stopped", {
    ItemId: item.Id,
    MediaSourceId: mediaSourceId,
    PlaySessionId: playSessionId,
    PositionTicks: endSeconds * TICKS_PER_SECOND,
  }, token);

  if (boolParam(config.markWatched, true)) {
    await embyPost(config, `/Users/${auth.User.Id}/PlayedItems/${item.Id}`, {}, token);
  }

  return { runtimeSeconds, startSeconds, endSeconds, watchedSeconds };
}

function nextDueFromConfig(config, now) {
  const intervalMs = numberParam(config.intervalHours, 168, 1) * 60 * 60 * 1000;
  const jitterHours = numberParam(config.intervalJitterHours, 0, 0);
  const jitterMs = jitterHours > 0 ? Math.floor(Math.random() * jitterHours * 60 * 60 * 1000) : 0;
  return {
    intervalMs,
    jitterMs,
    nextDue: now + intervalMs + jitterMs,
  };
}

async function executeKeepAlive(config, forceRun) {
  const now = Date.now();
  const lastKey = storageKey(config);
  const dueKey = nextDueKey(config);
  const lastRun = Number(Widget.storage.get(lastKey) || 0);
  const storedNextDue = Number(Widget.storage.get(dueKey) || 0);
  const intervalHours = numberParam(config.intervalHours, 168, 1);
  const fallbackNextDue = lastRun ? lastRun + intervalHours * 60 * 60 * 1000 : 0;
  const currentNextDue = storedNextDue || fallbackNextDue;
  const targetLibrary = String(config.libraryName || "全部资源库").trim() || "全部资源库";

  if (!forceRun && currentNextDue > 0 && now < currentNextDue) {
    return [
      statusItem("skipped", "保号未到时间", [
        `资源库：${targetLibrary}`,
        `上次执行：${formatTime(lastRun)}`,
        `下次执行：${formatTime(currentNextDue)}`,
        `执行间隔：${intervalHours} 小时`,
        "首页已检查，本次不会请求 Emby。",
      ].join("\n")),
      ...historyItems(config),
    ];
  }

  const auth = await authenticate(config);
  const libraries = await getLibraries(config, auth);
  const picked = await getRandomItem(config, auth, libraries);
  const playback = await reportPlayback(config, auth, picked.item);
  const schedule = nextDueFromConfig(config, now);
  Widget.storage.set(lastKey, String(now));
  Widget.storage.set(dueKey, String(schedule.nextDue));

  const title = picked.item.SeriesName
    ? `${picked.item.SeriesName} - ${picked.item.Name || picked.item.Id}`
    : `${picked.item.Name || picked.item.Id}`;
  const posterPath = itemImageUrl(config, picked.item, auth.AccessToken);
  const account = auth.User.Name || config.username;
  const library = picked.library.Name || picked.library.Id;
  saveHistoryRecord(config, {
    time: now,
    itemId: picked.item.Id,
    title,
    account,
    library,
    watchedSeconds: playback.watchedSeconds,
    startSeconds: playback.startSeconds,
    endSeconds: playback.endSeconds,
    markWatched: boolParam(config.markWatched, true),
    posterPath,
  });

  return [
    statusItem(`item:${picked.item.Id}`, `保号完成：${title}`, [
      `账号：${account}`,
      `资源库：${library}`,
      `模拟观看：${playback.watchedSeconds} 秒`,
      `播放区间：${playback.startSeconds}s - ${playback.endSeconds}s`,
      `标记已看：${boolParam(config.markWatched, true) ? "是" : "否"}`,
      `本次执行：${formatTime(now)}`,
      `执行间隔：${intervalHours} 小时`,
      `随机延迟：${Math.round(schedule.jitterMs / 60000)} 分钟`,
      `下次执行：${formatTime(schedule.nextDue)}`,
    ].join("\n"), posterPath ? { posterPath, backdropPath: posterPath } : {}),
    ...historyItems(config).slice(1),
  ];
}

async function saveConfig(params = {}) {
  try {
    const config = normalizeConfig(params);
    const wantsForceRun = config.executionMode === "once";
    const consumedKey = forceOnceKey(config);
    const forceRun = wantsForceRun && Widget.storage.get(consumedKey) !== "1";

    if (!wantsForceRun) {
      Widget.storage.set(consumedKey, "0");
    }

    const result = await executeKeepAlive(config, forceRun);
    if (forceRun) {
      Widget.storage.set(consumedKey, "1");
    }
    return result;
  } catch (error) {
    console.error("[embyKeeper] save config failed:", error.message || error);
    throw error;
  }
}

async function loadDetail(link) {
  return statusItem(
    String(link || "help"),
    "Emby 自动保号",
    "把“保存配置”添加到首页；它会按间隔自动保号，并显示最近的观看记录。"
  );
}
