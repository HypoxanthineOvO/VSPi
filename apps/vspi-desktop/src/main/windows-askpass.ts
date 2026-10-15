export const windowsAskpassSource = String.raw`
using System;
using System.Diagnostics;
using System.Text;

public static class Askpass {
  private static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') {
        result.Append('\\', slashes * 2 + 1);
        result.Append(c);
      } else {
        result.Append('\\', slashes);
        result.Append(c);
      }
      slashes = 0;
    }
    result.Append('\\', slashes * 2);
    return result.Append('"').ToString();
  }

  public static int Main(string[] args) {
    try {
      string executable = Environment.GetEnvironmentVariable("VSPI_ASKPASS_ELECTRON");
      string client = Environment.GetEnvironmentVariable("VSPI_ASKPASS_CLIENT");
      if (String.IsNullOrEmpty(executable) || String.IsNullOrEmpty(client) || args.Length != 1) return 1;
      var info = new ProcessStartInfo(executable, Quote(client) + " " + Quote(args[0]));
      info.UseShellExecute = false;
      info.CreateNoWindow = true;
      info.RedirectStandardOutput = true;
      info.RedirectStandardError = true;
      info.StandardOutputEncoding = new UTF8Encoding(false);
      info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
      info.EnvironmentVariables.Remove("NODE_OPTIONS");
      using (var child = Process.Start(info)) {
        var output = child.StandardOutput.ReadToEndAsync();
        var error = child.StandardError.ReadToEndAsync();
        if (!child.WaitForExit(120000)) { child.Kill(); return 1; }
        if (child.ExitCode != 0) return child.ExitCode;
        error.GetAwaiter().GetResult();
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.Write(output.GetAwaiter().GetResult());
        return 0;
      }
    } catch { return 1; }
  }
}
`;
