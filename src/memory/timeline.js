/**
 * Timeline module - append, query, and summarize memory events.
 * Ported from D version for audit trail and memory lifecycle tracking.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../config.js';

function generateEventId() {
  return 'evt-' + crypto.randomBytes(6).toString('hex');
}

/**
 * Append an event to the timeline log.
 * @param {string} timelinePath - Path to the JSONL timeline file
 * @param {Object} event - Event data with memory_id, session_id, event_type, created_at, payload
 * @returns {Object} The appended event
 */
export function appendEvent(timelinePath, { memory_id, session_id, event_type, created_at, payload }) {
  const event = {
    event_id: generateEventId(),
    memory_id: memory_id || '',
    session_id: session_id || '',
    event_type: event_type || '',
    created_at: created_at || new Date().toISOString(),
    payload: payload || {},
  };

  try {
    const dir = path.dirname(timelinePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.appendFileSync(timelinePath, JSON.stringify(event) + '\n', 'utf8');
    return event;
  } catch (error) {
    logger.error(`Failed to append timeline event: ${error}`);
    return event;
  }
}

/**
 * Load all events from the timeline file.
 * @param {string} timelinePath - Path to the JSONL timeline file
 * @returns {Array} Sorted array of events (newest first)
 */
export function loadEvents(timelinePath) {
  if (!fs.existsSync(timelinePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(timelinePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    const events = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(e => e);

    events.sort((a, b) => {
      const timeDiff = (b.created_at || '').localeCompare(a.created_at || '');
      if (timeDiff !== 0) return timeDiff;
      return (b.event_id || '').localeCompare(a.event_id || '');
    });

    return events;
  } catch (error) {
    logger.error(`Failed to load timeline events: ${error}`);
    return [];
  }
}

/**
 * Query events with filters.
 * @param {string} timelinePath - Path to the JSONL timeline file
 * @param {Object} filters - Filter options: memory_id, session_id, limit
 * @returns {Object} Query result with filters, event_count, and events
 */
export function queryEvents(timelinePath, { memory_id, session_id, limit = 50 } = {}) {
  const effectiveLimit = Math.max(parseInt(limit) || 50, 1);
  const events = loadEvents(timelinePath);

  const filtered = events.filter(event => {
    if (memory_id && event.memory_id !== memory_id) return false;
    if (session_id && event.session_id !== session_id) return false;
    return true;
  });

  return {
    filters: { memory_id, session_id, limit: effectiveLimit },
    event_count: filtered.length,
    events: filtered.slice(0, effectiveLimit),
  };
}

/**
 * Summarize events for a set of memory IDs.
 * @param {string} timelinePath - Path to the JSONL timeline file
 * @param {Object} options - Options with memory_ids array and limit
 * @returns {Object} Summary with memory_ids, event_count, and recent_events
 */
export function summarizeEvents(timelinePath, { memory_ids, limit = 5 } = {}) {
  const uniqueIds = [];
  for (const id of memory_ids || []) {
    if (id && !uniqueIds.includes(id)) {
      uniqueIds.push(id);
    }
  }

  if (uniqueIds.length === 0) {
    return { memory_ids: [], event_count: 0, recent_events: [] };
  }

  const events = loadEvents(timelinePath);
  const filtered = events.filter(event => uniqueIds.includes(event.memory_id));

  return {
    memory_ids: uniqueIds,
    event_count: filtered.length,
    recent_events: filtered.slice(0, Math.max(parseInt(limit) || 5, 1)),
  };
}

export default {
  appendEvent,
  loadEvents,
  queryEvents,
  summarizeEvents,
};
