const RELEASE_ORIGIN = "https://github.com";
const REPOSITORY_PATH = "HypoxanthineOvO/VSPi";
const STABLE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效`);
  return value;
}

function compareVersionKeys(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function releaseTagVersion(value) {
  const release = record(value, "GitHub Release");
  const tag = release.tag_name;
  if (typeof tag !== "string" || !STABLE_TAG_PATTERN.test(tag)) throw new Error("GitHub Release tag 不是稳定 SemVer");
  return tag.slice(1);
}

export function selectGitHubVspiRelease(value) {
  if (!Array.isArray(value)) throw new Error("GitHub Release 列表格式无效");
  let selected;
  let selectedKey;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.draft) continue;
    const tag = entry.tag_name;
    if (typeof tag !== "string" || !STABLE_TAG_PATTERN.test(tag)) continue;
    const key = tag.slice(1).split(".").map(Number);
    if (selectedKey === undefined || compareVersionKeys(key, selectedKey) > 0) {
      selected = entry;
      selectedKey = key;
    }
  }
  if (selected === undefined) throw new Error("GitHub 上未找到 VSPi Release");
  return selected;
}

export function parseGitHubVspiRelease(value) {
  const release = record(value, "GitHub Release");
  const version = releaseTagVersion(release);

  const body = release.body;
  const checksum = typeof body === "string" ? /SHA-256:\s*`([a-f0-9]{64})`/i.exec(body)?.[1]?.toLowerCase() : undefined;
  if (!checksum) throw new Error(`VSPi ${version} Release 缺少 SHA-256`);

  const filename = `vspi-${version}.tgz`;
  const expectedUrl = `${RELEASE_ORIGIN}/${REPOSITORY_PATH}/releases/download/v${version}/${filename}`;
  const assets = release.assets;
  const matched = Array.isArray(assets)
    ? assets
        .map((asset) => record(asset, "GitHub Release asset"))
        .filter((asset) => asset.name === filename && asset.browser_download_url === expectedUrl)
    : [];
  if (matched.length !== 1) throw new Error(`VSPi ${version} Release 缺少唯一受信任的安装包`);
  return { version, checksum, downloadUrl: expectedUrl };
}
