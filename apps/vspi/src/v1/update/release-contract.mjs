const PROJECT_ORIGIN = "https://gitlab.vsplab.cn";
const PROJECT_PATH = "heyx/vspi";

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效`);
  return value;
}

export function parseVspiRelease(value) {
  const release = record(value, "GitLab Release");
  const tag = release.tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("GitLab Release tag 不是稳定 SemVer");
  const version = tag.slice(1);

  const description = release.description;
  const checksum =
    typeof description === "string" ? /SHA-256:\s*`([a-f0-9]{64})`/i.exec(description)?.[1]?.toLowerCase() : undefined;
  if (!checksum) throw new Error(`VSPi ${version} Release 缺少 SHA-256`);

  const filename = `vspi-${version}.tgz`;
  const expectedUrl = `${PROJECT_ORIGIN}/${PROJECT_PATH}/-/releases/${tag}/downloads/${filename}`;
  const assets = record(release.assets, "GitLab Release assets");
  const links = assets.links;
  const matched = Array.isArray(links)
    ? links
        .map((link) => record(link, "GitLab Release asset"))
        .find((link) => link.name === filename && link.direct_asset_url === expectedUrl)
    : undefined;
  if (!matched) throw new Error(`VSPi ${version} Release 缺少受信任的安装包`);
  return { version, checksum, downloadUrl: expectedUrl };
}
