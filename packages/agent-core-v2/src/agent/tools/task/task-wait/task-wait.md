Wait for background tasks to finish without ending the current turn.

This tool is off by default and is reserved for one narrow case: an uninterruptible atomic operation that must complete in this same turn. Waiting for a task result is not that case. Every background task notifies you on completion, so end the current turn and let that notification resume the work. Never call WaitFor to hold a turn open while work runs, to keep a goal alive, or because the next step depends on a result.

Guidelines:

- "My next step depends on the result", "I have no other work", and "I want to continue in the same turn" do not qualify. End the turn and wait for the automatic notification.
- Do not call WaitFor right after dispatching background work. If the result had to be obtained synchronously from the outset, run that work in the foreground instead.
- `timeout` is required, in seconds, capped at 600.
- A timeout is not an error: the result lists the tasks that are still running. Do not call WaitFor again unless the same strict atomic-operation exception still applies after you re-evaluate the situation; otherwise end the turn for automatic notification.
- Without `task_id`, the wait ends as soon as any background task that was running at call time finishes. Tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.
- With `task_id`, the wait ends when that task finishes. An unknown `task_id` is an error; a task that has already finished returns immediately.
- When no background tasks are running, WaitFor returns immediately without waiting.
- When the wait ends because a task finished, the result also lists other tasks that finished during the wait window, so failures surface with context.
- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a user interruption) leaves every task running.
- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.
- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.
