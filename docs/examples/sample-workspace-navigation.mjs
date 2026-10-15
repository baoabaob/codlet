// Call from the consumer with its prepared owner-scoped navigation session.
// Keep native input visible but inert until confirmation fits the current
// consumer intent and workspace snapshot.
export async function sampleWorkspaceNavigation(workspace, navigation, threadId, signal) {
  const start = performance.now();
  const operation = navigation.open({ threadId }, { signal });
  const synchronousMs = performance.now() - start;
  const executed = await operation.executed;
  const executedMs = performance.now() - start;
  const routeAtReceipt = workspace.getSnapshot().threadId;
  const committed = await operation.committed;
  const committedMs = performance.now() - start;
  const inputConfirmed = committed.threadId === threadId && workspace.getSnapshot().threadId === threadId;
  operation.dispose();
  return { threadId, synchronousMs, executedMs, committedMs, routeAtReceipt,
    executed, committed, inputConfirmed };
}
