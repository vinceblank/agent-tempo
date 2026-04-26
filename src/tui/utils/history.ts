/**
 * Persistent command history for the TUI.
 * Saves to ~/.claude-tempo/tui-history.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HISTORY_DIR = path.join(os.homedir(), '.claude-tempo');
const HISTORY_FILE = path.join(HISTORY_DIR, 'tui-history.json');
const MAX_ENTRIES = 500;
const CURRENT_VERSION = 1;

interface HistoryFile {
  version: number;
  entries: string[];
}

/**
 * Load command history from disk.
 * Returns empty array if file doesn't exist or is corrupted.
 */
export function loadHistory(): string[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
    const data: HistoryFile = JSON.parse(raw);
    if (data.version !== CURRENT_VERSION || !Array.isArray(data.entries)) return [];
    return data.entries.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Save command history to disk.
 * Creates ~/.claude-tempo/ if it doesn't exist.
 */
export function saveHistory(entries: string[]): void {
  try {
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
    const data: HistoryFile = {
      version: CURRENT_VERSION,
      entries: entries.slice(-MAX_ENTRIES),
    };
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Silently fail — history is non-critical
  }
}

