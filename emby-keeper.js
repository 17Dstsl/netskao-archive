WidgetMetadata = {
  id: "embyKeeper",
  title: "Emby 自动保号",
  version: "2.1.0",
  requiredVersion: "0.0.1",
  description: "先保存 Emby 配置，再把首页保号检查添加到 Forward 首页；首页加载时到期才执行。",
  author: "Codex",
  description: "\u53ea\u9700\u6dfb\u52a0\u201c\u4fdd\u5b58\u914d\u7f6e\u201d\u5230\u9996\u9875\uff1b\u9996\u9875\u52a0\u8f7d\u65f6\u4fdd\u5b58\u5f53\u524d\u53c2\u6570\uff0c\u5e76\u6309\u8bbe\u7f6e\u7684\u5c0f\u65f6\u95f4\u9694\u81ea\u52a8\u68c0\u67e5\u4fdd\u53f7\u3002",
  site: "https://emby.media",
  detailCacheDuration: 0,
  modules: [
    {
      id: "saveConfig",
      title: "保存配置",
      description: "首次使用先运行这里；首页卡片会读取这份配置。",
      functionName: "saveConfig",
      description: "\u6b64\u6a21\u5757\u540c\u65f6\u662f\u914d\u7f6e\u5165\u53e3\u548c\u9996\u9875\u81ea\u52a8\u68c0\u67e5\uff1b\u6dfb\u52a0\u540e\u53ef\u5728\u201c\u4fee\u6539\u6570\u636e\u6e90\u201d\u4e2d\u8c03\u6574\u6240\u6709\u53c2\u6570\u3002",
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
          value: "Forward",
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
  legacyModules: [
    {
      id: "homeCheck",
      title: "首页保号检查",
      description: "添加到 Forward 首页使用；无参数，自动读取已保存配置。",
      functionName: "homeCheck",
      cacheDuration: 0,
      params: [],
    },
    {
      id: "runOnce",
      title: "立即执行一次",
      description: "用于测试配置；无视间隔，读取已保存配置后立刻执行。",
      functionName: "runOnce",
      cacheDuration: 0,
      params: [],
    },
  ],
};

const TICKS_PER_SECOND = 10000000;
const CONFIG_KEY = "embyKeeper:config";
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
    deviceName: String(params.deviceName || "Forward").trim() || "Forward",
    maxRetries: String(numberParam(params.maxRetries, 3, 1)),
  };
  if (!/^https?:\/\//i.test(config.serverUrl)) {
    throw new Error("Emby 服务器地址需要以 http:// 或 https:// 开头");
  }
  if (!config.password) throw new Error("请填写Emby 密码");
  return config;
}

function loadConfig() {
  const raw = Widget.storage.get(CONFIG_KEY);
  if (!raw) throw new Error("还没有保存配置。请先运行“保存配置”。");
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    throw new Error(`配置读取失败：${error.message || error}`);
  }
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
  return String(config.deviceName || "Forward").trim() || "Forward";
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
  if (!item || !item.Id || !item.ImageTags || !item.ImageTags.Primary) return undefined;
  return `${config.serverUrl}/Items/${item.Id}/Images/Primary?api_key=${encodeURIComponent(token)}`;
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

  return [
    statusItem(`item:${picked.item.Id}`, `保号完成：${title}`, [
      `账号：${auth.User.Name || config.username}`,
      `资源库：${picked.library.Name || picked.library.Id}`,
      `模拟观看：${playback.watchedSeconds} 秒`,
      `播放区间：${playback.startSeconds}s - ${playback.endSeconds}s`,
      `标记已看：${boolParam(config.markWatched, true) ? "是" : "否"}`,
      `本次执行：${formatTime(now)}`,
      `执行间隔：${intervalHours} 小时`,
      `随机延迟：${Math.round(schedule.jitterMs / 60000)} 分钟`,
      `下次执行：${formatTime(schedule.nextDue)}`,
    ].join("\n"), posterPath ? { posterPath } : {}),
  ];
}

async function saveConfig(params = {}) {
  try {
    const config = normalizeConfig(params);
    Widget.storage.set(CONFIG_KEY, JSON.stringify(config));
    return executeKeepAlive(config, false);
    const targetLibrary = config.libraryName || "全部资源库";
    return [
      statusItem("config-saved", "配置已保存", [
        `服务器：${config.serverUrl}`,
        `账号：${config.username}`,
        `资源库：${targetLibrary}`,
        `执行间隔：${config.intervalHours} 小时`,
        `随机延迟：0-${config.intervalJitterHours} 小时`,
        `播放时长：${config.playDuration} 秒 + 0-10% 随机`,
        "现在可以把“首页保号检查”添加到 Forward 首页。",
      ].join("\n")),
    ];
  } catch (error) {
    console.error("[embyKeeper] save config failed:", error.message || error);
    throw error;
  }
}

async function homeCheck() {
  try {
    return executeKeepAlive(loadConfig(), false);
  } catch (error) {
    console.error("[embyKeeper] home check failed:", error.message || error);
    throw error;
  }
}

async function runOnce() {
  try {
    return executeKeepAlive(loadConfig(), true);
  } catch (error) {
    console.error("[embyKeeper] run once failed:", error.message || error);
    throw error;
  }
}

async function loadDetail(link) {
  return statusItem(
    String(link || "help"),
    "Emby 自动保号",
    "先运行“保存配置”，再把“首页保号检查”添加到 Forward 首页。"
  );
}
