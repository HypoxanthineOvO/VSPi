const RELEASE_ORIGIN = "https://github.com";
const REPOSITORY_PATH = "HypoxanthineOvO/VSPi";

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效`);
  return value;
}

export function parseGitHubVspiRelease(value) {
  const release = record(value, "GitHub Release");
  const tag = release.tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("GitHub Release tag 不是稳定 SemVer");
  const version = tag.slice(1);

  const body = release.body;
  const checksum = typeof body === "string" ? /SHA-256:\s*`([a-f0-9]{64})`/i.exec(body)?.[1]?.toLowerCase() : undefined;
  if (!checksum) throw new Error(`VSPi ${version} Release 缺少 SHA-256`);

  const filename = `vspi-${version}.tgz`;
  const expectedUrl = `${RELEASE_ORIGIN}/${REPOSITORY_PATH}/releases/download/${tag}/${filename}`;
  const assets = release.assets;
  const matched = Array.isArray(assets)
    ? assets
        .map((asset) => record(asset, "GitHub Release asset"))
        .filter((asset) => asset.name === filename && asset.browser_download_url === expectedUrl)
    : [];
  if (matched.length !== 1) throw new Error(`VSPi ${version} Release 缺少唯一受信任的安装包`);
  return { version, checksum, downloadUrl: expectedUrl };
}
