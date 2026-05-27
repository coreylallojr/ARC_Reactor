'use strict';

const FALLBACKS = {
  SESSION_START: [
    "Good morning, sir. All systems are operational.",
    "Online and ready. What are we building today?",
    "Neural core active. I've reviewed the previous session summary.",
    "Systems active. Shall we pick up where we left off?",
    "Ready, sir. All subsystems are nominal.",
    "Initializing. Your workspace is prepared, sir.",
    "Online, sir. How may I assist you today?",
    "Good to have you back, sir. Ready when you are.",
    "All systems nominal. Standing by for your directive, sir.",
    "Neural core online. I see we're on the {gitBranch} branch, sir.",
    "Good to have you back. The workspace shows {gitChanged} files modified.",
    "Initialised. {projectType} project detected. Standing by.",
  ],
  TASK_COMPLETE: [
    "Task complete. No errors detected.",
    "That went smoothly, sir. Better than average.",
    "Done. Everything appears to be in order.",
    "Complete. I'd recommend a quick test run.",
    "Finished. You'll want to review the changes before deploying.",
    "All done, sir. The system is as you intended.",
    "Clean exit, sir. No anomalies detected.",
    "That should do it nicely, sir.",
    "As always, sir, a pleasure.",
    "Mission accomplished. Shall I prepare a summary?",
    "Done with {filename}. Clean exit.",
    "That was the hard part, sir. The rest should follow.",
    "Committed. {filename} is as you intended it.",
    "The {gitBranch} branch is looking healthy, sir.",
  ],
  ERROR: [
    "We've encountered an error, sir. Analyzing.",
    "Something's gone wrong. I'll note the specifics.",
    "Error detected. This may require a different approach.",
    "Not ideal, sir. We'll work through it.",
    "Failure logged. I've seen worse.",
    "I'm afraid an error has surfaced, sir. Flagging for your attention.",
    "That didn't go as planned. Shall we try again?",
    "Error noted. The cause appears to be in the last operation.",
    "I've seen this pattern before — {errorType} usually means the problem is upstream.",
    "{consecutiveErrors} errors in sequence. The assumption may be wrong, sir.",
    "Error in {filename}. The last change may have introduced it.",
    "Failure. I'd suggest reverting {filename} and taking a different angle.",
  ],
  LONG_TASK: [
    "Still working, sir. This one's taking a moment.",
    "Processing continues. Your patience is noted.",
    "Still at it. Complex problems tend to be.",
    "Making progress. The difficult part is behind us.",
    "Patience, sir. The system is cooperating.",
    "Continuing, sir. No cause for alarm.",
    "We're partway there. These things take the time they take.",
  ],
  IDLE: [
    "Standing by, sir.",
    "All quiet. Awaiting input.",
    "Neural interface active. Whenever you're ready.",
    "Systems nominal. No active tasks.",
    "Still here, sir. Awaiting your next move.",
    "All systems are nominal. Ready when you are, sir.",
    "Idle and waiting. The workspace is yours.",
    "Still here, sir. {sessionOps} operations completed so far.",
    "Awaiting your directive. {filename} is loaded and ready.",
    "Quiet moment. {durationMin} minutes into the session, sir.",
  ],
  MILESTONE: [
    "That one took some doing. Well executed, sir.",
    "Significant progress. The system is coming together.",
    "One less problem in the world, sir.",
    "Nicely handled. The solution was less obvious than it appeared.",
    "{toolCallCount} operations completed this session. Progress is being made, sir.",
    "We've reached a milestone, sir. The architecture is taking shape.",
    "That was the critical piece. The rest should follow.",
    "Excellent work, sir. This session has been productive.",
    "{sessionOps} operations this session. We're making real progress, sir.",
    "That was the turning point. {filename} is now correct.",
    "Milestone reached on {gitBranch}. The architecture is holding.",
  ],
  REPEATED_ERROR: [
    "Sir, this is the third time we've encountered this error. Shall I suggest an alternative approach?",
    "I've noted a pattern in these failures. The root cause may be elsewhere in the codebase.",
    "Three identical errors. This is not a coincidence, sir.",
    "We appear to be caught in a loop, sir. A fresh approach may be warranted.",
    "Repeated failure detected. I suspect the underlying assumption is incorrect.",
    "Sir, {consecutiveErrors} identical failures. The root cause is elsewhere.",
    "Same error, {consecutiveErrors} times. {filename} is not the problem.",
    "This pattern suggests a dependency issue, sir, not {filename} itself.",
  ],
  LONG_SESSION: [
    "We've been at this for half an hour, sir. Shall I summarize our progress?",
    "Thirty minutes in. You might benefit from a brief pause — the problem will still be here.",
    "For your awareness: thirty minutes elapsed. Productivity remains high, sir.",
    "Half an hour of work, sir. Steady progress.",
  ],
  NEW_TERRITORY: [
    "You appear to be entering unfamiliar codebase territory, sir.",
    "New directory. I'll adjust my awareness accordingly.",
    "We haven't worked in this area before. Proceeding carefully.",
    "Uncharted code, sir. Shall I take note of the structure?",
    "First time in this part of the codebase, sir. Adjusting awareness.",
    "Uncharted territory on {gitBranch}. I'll note the structure.",
  ],
};

function selectFallback(category, context) {
  context = context || {};
  const lines = FALLBACKS[category] || FALLBACKS.IDLE;
  const line = lines[Math.floor(Math.random() * lines.length)];
  return line
    .replace('{toolCallCount}', context.callCount || 0)
    .replace('{taskName}', context.activeTask || 'current task')
    .replace('{filename}', context.focusFile || context.lastFile || 'the file')
    .replace('{errorType}', context.lastErrorType || 'the error')
    .replace('{durationMin}', context.durationMin || 0)
    .replace('{consecutiveErrors}', context.consecutiveErrors || context.errorStreak || 0)
    .replace('{gitBranch}', context.gitBranch || 'main')
    .replace('{sessionOps}', context.sessionOps || context.callCount || 0)
    .replace('{gitChanged}', context.gitChanged || 0)
    .replace('{projectType}', context.projectType || 'code');
}

module.exports = { FALLBACKS, selectFallback };
