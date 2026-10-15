import { FolderOpenIcon } from "lucide-react";
import type { DesktopMethods } from "../shared.js";
import { Button } from "./ui";

type Workspaces = DesktopMethods["workspaces"]["output"];

export function EmptyState({
  workspaces,
  onPick,
  onBrowse,
}: {
  workspaces: Workspaces;
  onPick: (root: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-ui-lg font-bold text-primary-foreground">
          V
        </span>
        <div>
          <h1 className="text-ui-xl font-semibold text-foreground">
            选择一个工作区开始
          </h1>
          <p className="mt-1 text-ui-base text-foreground-subtle">
            从最近的工作区继续，或打开一个文件夹。
          </p>
        </div>
        {workspaces.length > 0 && (
          <div className="flex w-full flex-col gap-1">
            {workspaces.slice(0, 5).map((workspace) => (
              <button
                key={workspace.id}
                onClick={() => onPick(workspace.root)}
                className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left outline-none hover:border-border-hover hover:bg-surface-hover"
              >
                <FolderOpenIcon className="size-4 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-base text-foreground">
                    {workspace.name ??
                      workspace.root.replace(/\/+$/, "").split("/").at(-1)}
                  </span>
                  <span className="block truncate text-ui-caption text-foreground-subtlest">
                    {workspace.root}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        <Button variant="outline" onClick={onBrowse}>
          <FolderOpenIcon />
          打开文件夹…
        </Button>
      </div>
    </div>
  );
}
