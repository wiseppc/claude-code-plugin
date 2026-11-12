#!/usr/bin/env node
// SessionStart hook for wiseppc-live. Prints a systemMessage when the standard wiseppc plugin is
// also enabled. Local files only: no network, no credentials read. Prints nothing otherwise.
import { duplicateWarning } from '../lib/settings.mjs';

try {
  const warning = duplicateWarning();
  if (warning) process.stdout.write(`${JSON.stringify({ systemMessage: warning })}\n`);
} catch {
  // A hook must never fail a session start.
}
