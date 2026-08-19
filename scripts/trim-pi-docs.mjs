import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

// C19 快速修复：VSPi 与上游 pi CLI 是不同产品；捆绑在其依赖里的 pi docs 描述的
// 命令与扩展行为不适用于 VSPi，曾被模型当作事实来源推荐不存在的命令。
// 安装后移除这些文档目录，从源头断掉错误信息；对 VSPi 运行时零影响。

const TRIMMED_PACKAGES = [
  // pi-coding-agent 的 README 自带上游命令表（含 VSPi 不存在的 /reload、/trust 等），
  // examples 展示上游扩展 API；两者与 docs 一样会误导模型，一并移除。
  { name: "@earendil-works/pi-coding-agent", dirs: ["docs", "examples", "README.md"] },
  { name: "@earendil-works/pi-tui", dirs: ["docs"] },
];

async function packageRoot(specifier, expectedName) {
  let cursor = dirname(fileURLToPath(import.meta.resolve(specifier)));
  const filesystemRoot = parse(cursor).root;
  while (cursor !== filesystemRoot) {
    try {
      const manifest = JSON.parse(await readFile(join(cursor, "package.json"), "utf8"));
      if (manifest.name === expectedName) return cursor;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    cursor = dirname(cursor);
  }
  throw new Error(`Cannot locate package root for ${expectedName}`);
}

let removed = 0;
for (const { name, dirs } of TRIMMED_PACKAGES) {
  const root = await packageRoot(name, name);
  for (const dir of dirs) {
    const target = join(root, dir);
    try {
      await stat(target);
      await rm(target, { recursive: true, force: true });
      removed += 1;
      console.log(`Trimmed upstream docs: ${target}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
if (removed === 0) console.log("No upstream pi docs found to trim (already removed)");
