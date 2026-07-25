WidgetMetadata = {
  id: "embyKeeper",
  title: "Emby 自动保号",
  version: "1.4.0",
  requiredVersion: "0.0.1",
  description: "首页加载时检查间隔，到期后从指定 Emby 资源库随机模拟观看一次。",
  author: "Codex",
  site: "https://emby.media",
  detailCacheDuration: 0,
  modules: [
    {
      id: "runKeepAlive",
      title: "保号检查",
      description: "适合放在 Forward 首页：每次加载先检查间隔，未到期不会请求 Emby。",
      functionName: "runKeepAlive",
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
        {
          name: "username",
          title: "Emby 用户名",
          type: "input",
          description: "用于登录 Emby 的账号。",
        },
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
          type: "count",
          value: "168",
          description: "首页加载时检查；未到间隔只显示状态，不执行保号。168 小时约等于 7 天。",
        },
        {
          name: "playDuration",
          title: "播放时长（秒）",
          type: "count",
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
          name: "forceRun",
          title: "强制执行一次",
          type: "enumeration",
          value: "false",
          description: "用于测试；选择“是”会忽略间隔。",
          enumOptions: [
            { title: "否", value: "false" },
            { title: "是", value: "true" },
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
          type: "count",
          value: "3",
          description: "随机资源为空时换库或换片重试。",
          belongTo: { paramName: "advanced", value: ["show"] },
        },
        {
          name: "intervalJitterHours",
          title: "间隔随机延迟（小时）",
          type: "count",
          value: "0",
          description: "下次执行时间额外增加 0 到该值之间的随机小时数；0 表示关闭。",
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

function requireText(params, name, label) {
  const value = String(params[name] || "").trim();
  if (!value) throw new Error(`请填写${label}`);
  return value;
}

function requireServerUrl(params) {
  const value = requireText(params, "serverUrl", "Emby 服务器地址");
  if (!/^https?:\/\//i.test(value)) {
    throw new Error("Emby 服务器地址需要以 http:// 或 https:// 开头");
  }
  return cleanBaseUrl(value);
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

function getDeviceName(params) {
  return String(params.deviceName || "Forward").trim() || "Forward";
}

function deviceId(params) {
  return getDeviceName(params).replace(/\s+/g, "-");
}

function authHeader(params, token) {
  const parts = [
    'MediaBrowser Client="Forward"',
    `Device="${getDeviceName(params)}"`,
    `DeviceId="${deviceId(params)}"`,
    'Version="1.0.0"',
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(", ");
}

function embyHeaders(params, token) {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Emby-Client": "Forward",
    "X-Emby-Device-Name": getDeviceName(params),
    "X-Emby-Device-Id": deviceId(params),
    "X-Emby-Client-Version": "1.0.0",
    "X-Emby-Authorization": authHeader(params, token),
  };
}

function urlFor(params, path) {
  const baseUrl = requireServerUrl(params);
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function embyGet(params, path, token) {
  const res = await Widget.http.get(urlFor(params, path), {
    headers: embyHeaders(params, token),
  });
  return res.data;
}

async function embyPost(params, path, body, token) {
  const res = await Widget.http.post(urlFor(params, path), body || {}, {
    headers: embyHeaders(params, token),
  });
  return res.data;
}

async function authenticate(params) {
  requireServerUrl(params);
  requireText(params, "username", "Emby 用户名");
  requireText(params, "password", "Emby 密码");
  return embyPost(params, "/Users/AuthenticateByName", {
    Username: String(params.username || "").trim(),
    Pw: String(params.password || ""),
  });
}

async function getLibraries(params, auth) {
  const data = await embyGet(params, `/Users/${auth.User.Id}/Views`, auth.AccessToken);
  const items = data.Items || [];
  return items.filter((item) => {
    const type = String(item.CollectionType || "");
    return type === "movies" || type === "tvshows" || type === "boxsets" || type === "";
  });
}

function filterLibraries(libraries, params) {
  const keyword = String(params.libraryName || "").trim().toLowerCase();
  if (!keyword) return libraries;
  return libraries.filter((library) => String(library.Name || "").toLowerCase().includes(keyword));
}

function pickOne(items) {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function storageKey(params) {
  const server = cleanBaseUrl(params.serverUrl).replace(/^https?:\/\//i, "");
  const user = String(params.username || "").trim();
  const library = String(params.libraryName || "all").trim() || "all";
  return `${STORE_PREFIX}:${server}:${user}:${library}`;
}

function jitterStorageKey(params) {
  return `${storageKey(params)}:nextDue`;
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

function itemImageUrl(params, item, token) {
  if (!item || !item.Id || !item.ImageTags || !item.ImageTags.Primary) return undefined;
  return `${cleanBaseUrl(params.serverUrl)}/Items/${item.Id}/Images/Primary?api_key=${encodeURIComponent(token)}`;
}

async function getRandomItem(params, auth, libraries) {
  const selected = filterLibraries(libraries, params);
  if (!selected.length) {
    const names = libraries.map((library) => library.Name).filter(Boolean).join(" / ");
    throw new Error(`没有匹配的资源库。当前可用资源库：${names || "无"}`);
  }

  const retries = numberParam(params.maxRetries, 3, 1);
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
    const data = await embyGet(params, `/Users/${auth.User.Id}/Items?${query}`, auth.AccessToken);
    const item = data.Items && data.Items[0];
    if (item) return { library, item };
  }

  throw new Error("没有找到可模拟观看的影片。可以清空资源库名称，或提高最大重试次数。");
}

async function reportPlayback(params, auth, item) {
  const token = auth.AccessToken;
  const playDuration = numberParam(params.playDuration, 300, 1);
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

  await embyPost(params, "/Sessions/Playing", {
    ItemId: item.Id,
    MediaSourceId: mediaSourceId,
    PlaySessionId: playSessionId,
    PositionTicks: startSeconds * TICKS_PER_SECOND,
    IsPaused: false,
    CanSeek: true,
  }, token);

  await embyPost(params, "/Sessions/Playing/Progress", {
    ItemId: item.Id,
    MediaSourceId: mediaSourceId,
    PlaySessionId: playSessionId,
    PositionTicks: endSeconds * TICKS_PER_SECOND,
    IsPaused: false,
  }, token);

  await embyPost(params, "/Sessions/Playing/Stopped", {
    ItemId: item.Id,
    MediaSourceId: mediaSourceId,
    PlaySessionId: playSessionId,
    PositionTicks: endSeconds * TICKS_PER_SECOND,
  }, token);

  if (boolParam(params.markWatched, true)) {
    await embyPost(params, `/Users/${auth.User.Id}/PlayedItems/${item.Id}`, {}, token);
  }

  return { runtimeSeconds, startSeconds, endSeconds, watchedSeconds };
}

async function runKeepAlive(params = {}) {
  try {
    const now = Date.now();
    const key = storageKey(params);
    const nextDueKey = jitterStorageKey(params);
    const intervalHours = numberParam(params.intervalHours, 168, 1);
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const lastRun = Number(Widget.storage.get(key) || 0);
    const storedNextDue = Number(Widget.storage.get(nextDueKey) || 0);
    const nextDue = storedNextDue || (lastRun ? lastRun + intervalMs : 0);
    const forceRun = boolParam(params.forceRun, false);
    const targetLibrary = String(params.libraryName || "全部资源库").trim() || "全部资源库";

    if (!forceRun && nextDue > 0 && now < nextDue) {
      return [
        statusItem("skipped", "保号未到时间", [
          `资源库：${targetLibrary}`,
          `上次执行：${formatTime(lastRun)}`,
          `下次执行：${formatTime(nextDue)}`,
          `执行间隔：${intervalHours} 小时`,
          "首页已检查，本次不会请求 Emby。",
        ].join("\n")),
      ];
    }

    const auth = await authenticate(params);
    const libraries = await getLibraries(params, auth);
    const picked = await getRandomItem(params, auth, libraries);
    const playback = await reportPlayback(params, auth, picked.item);
    const jitterHours = numberParam(params.intervalJitterHours, 0, 0);
    const jitterMs = jitterHours > 0 ? Math.floor(Math.random() * jitterHours * 60 * 60 * 1000) : 0;
    const newNextDue = now + intervalMs + jitterMs;
    Widget.storage.set(key, String(now));
    Widget.storage.set(nextDueKey, String(newNextDue));

    const title = picked.item.SeriesName
      ? `${picked.item.SeriesName} - ${picked.item.Name || picked.item.Id}`
      : `${picked.item.Name || picked.item.Id}`;
    const posterPath = itemImageUrl(params, picked.item, auth.AccessToken);

    return [
      statusItem(`item:${picked.item.Id}`, `保号完成：${title}`, [
        `账号：${auth.User.Name || params.username}`,
        `资源库：${picked.library.Name || picked.library.Id}`,
        `模拟观看：${playback.watchedSeconds} 秒`,
        `播放区间：${playback.startSeconds}s - ${playback.endSeconds}s`,
        `标记已看：${boolParam(params.markWatched, true) ? "是" : "否"}`,
        `本次执行：${formatTime(now)}`,
        `执行间隔：${intervalHours} 小时`,
        `随机延迟：${Math.round(jitterMs / 60000)} 分钟`,
        `下次执行：${formatTime(newNextDue)}`,
      ].join("\n"), posterPath ? { posterPath } : {}),
    ];
  } catch (error) {
    console.error("[embyKeeper] failed:", error.message || error);
    throw error;
  }
}

async function loadDetail(link) {
  return statusItem(
    String(link || "help"),
    "Emby 自动保号",
    "放在 Forward 首页时，每次首页加载会检查间隔；未到期不会请求 Emby。"
  );
}
