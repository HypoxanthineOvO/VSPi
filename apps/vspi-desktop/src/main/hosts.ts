import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const pathField = z
  .string()
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value));

export const remoteHostSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .max(64),
    label: z.string().min(1).max(256),
    host: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@%-]*$/)
      .max(255),
    port: z.number().int().min(1).max(65535).optional(),
    executable: pathField.optional(),
    homeDir: pathField.optional(),
  })
  .strict();
export type RemoteHost = z.infer<typeof remoteHostSchema>;

export const localConfigSchema = z
  .object({
    executable: pathField.optional(),
    executableArgs: z.array(pathField).max(8).optional(),
    homeDir: pathField.optional(),
  })
  .strict();
export type LocalConfig = z.infer<typeof localConfigSchema>;

const hostsFileSchema = z.object({
  local: localConfigSchema.default({}),
  remotes: z.array(remoteHostSchema).max(64).default([]),
  lastHostId: z.string().max(64).optional(),
});
export type HostsFile = z.infer<typeof hostsFileSchema>;

export const localHostSchema = localConfigSchema;
export const remoteInputSchema = remoteHostSchema.omit({ id: true }).extend({
  id: remoteHostSchema.shape["id"].optional(),
});

export function emptyHosts(): HostsFile {
  return { local: {}, remotes: [] };
}

export async function loadHosts(
  path: string,
  onRecovered?: (backupName: string) => void,
): Promise<HostsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyHosts();
    throw error;
  }
  try {
    return hostsFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError))
      throw error;
    const backup = `${path}.invalid-${Date.now()}`;
    await rename(path, backup);
    onRecovered?.(basename(backup));
    return emptyHosts();
  }
}

export async function saveHosts(path: string, hosts: HostsFile): Promise<void> {
  const parsed = hostsFileSchema.parse(hosts);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(tmp, path);
}

export interface LocalCommand {
  executable: string;
  executableArgs: string[];
  source: "saved" | "env" | "dev" | "path";
}
export interface ResolveDeps {
  fileExists?: (path: string) => boolean;
  pathLookup?: (name: string) => string | undefined;
}

export function resolveLocalCommand(
  saved: LocalConfig | undefined,
  env: NodeJS.ProcessEnv,
  appPath: string,
  deps: ResolveDeps = {},
): LocalCommand {
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path));
  const pathLookup =
    deps.pathLookup ??
    ((name: string) => {
      try {
        const found = execFileSync("which", [name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return found.split("\n")[0]?.trim() || undefined;
      } catch {
        return undefined;
      }
    });
  if (saved?.executable) {
    return {
      executable: saved.executable,
      executableArgs: saved.executableArgs ?? [],
      source: "saved",
    };
  }
  const fromEnv = env["VSPI_DESKTOP_EXECUTABLE"]?.trim();
  if (fromEnv) return { executable: fromEnv, executableArgs: [], source: "env" };
  const devBundle = join(appPath, "..", "vspi", "dist", "main.mjs");
  if (fileExists(devBundle)) {
    return {
      executable: "node",
      executableArgs: [devBundle],
      source: "dev",
    };
  }
  const onPath = pathLookup("vspi");
  return { executable: onPath ?? "vspi", executableArgs: [], source: "path" };
}

export function describeLocalCommand(
  command: LocalCommand,
  homeDir?: string,
): string {
  const parts = [
    command.executable,
    ...command.executableArgs,
    "daemon",
    "desktop",
    ...(homeDir ? ["--home-dir", homeDir] : []),
  ];
  return parts.join(" ");
}
