// oxlint-disable eslint-plugin-unicorn/prefer-top-level-await -- Electron entrypoints are bundled as CommonJS.
async function main() {
  const port = process.env["VSPI_ASKPASS_PORT"];
  const token = process.env["VSPI_ASKPASS_TOKEN"];
  if (!port || !token || !/^\d+$/.test(port)) process.exit(1);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: process.argv.at(-1) }),
      signal: AbortSignal.timeout(115_000),
    });
    if (!response.ok) process.exit(1);
    const result = (await response.json()) as { answer: string | null };
    if (result.answer === null) process.exit(1);
    process.stdout.write(`${result.answer}\n`);
  } catch {
    process.exit(1);
  }
}
void main();
