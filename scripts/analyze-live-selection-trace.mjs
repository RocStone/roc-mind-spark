#!/usr/bin/env node
// Analyze recorded input from the installed app. Does not generate input or maps.
import fs from 'node:fs';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/analyze-live-selection-trace.mjs /absolute/path/input.jsonl');
const rows = fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const native = rows.filter(row => row.kind === 'native-gesture');
function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const round = x => Math.round(x * 100) / 100;
  return { count: values.length, mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    p95: round(sorted[Math.ceil(sorted.length * .95) - 1]), max: round(sorted.at(-1)) };
}
const gestures = rows.filter(row => row.kind === 'page-gesture').map(page => {
  const down = page.events.find(e => e.kind === 'mousedown');
  const up = page.events.find(e => e.kind === 'mouseup');
  const moves = page.events.filter(e => e.kind === 'mousemove');
  const start = page.timeOrigin + down.t;
  const candidates = native.filter(n => Math.abs(n.events[0].receivedEpochMs - start) < 100
    && Math.abs(n.events[0].x - down.x) < 2
    && Math.abs(n.events[0].windowHeight - n.events[0].y - down.y) < 2);
  const input = candidates.length === 1 ? candidates[0].events : [];
  // Independently check browser timestamps by matching recorded positions in
  // chronological order. Fractional AppKit positions become integer DOM pixels.
  let cursor = 1;
  const delivery = [];
  for (const move of moves) {
    const index = input.findIndex((event, i) => i >= cursor && event.type === 6
      && Math.abs(event.x - move.x) < 1.1
      && Math.abs(event.windowHeight - event.y - move.y) < 1.1);
    if (index < 0) continue;
    const event = input[index];
    cursor = index + 1;
    delivery.push(page.timeOrigin + move.t - event.receivedEpochMs);
  }
  const ticks = page.events.filter(e => e.kind === 'display-tick');
  return { number: page.number, editor: page.editor, start: new Date(start).toISOString(),
    pageDurationMs: up ? up.t - down.t : null, nativeEvents: input.length,
    nativeReceiptMs: stats(input.map(e => (e.receivedUptime - e.eventUptime) * 1000)),
    pageEventAgeMs: stats(moves.map(e => e.t - e.eventTime)),
    coordinateMatchedDeliveryMs: stats(delivery),
    mouseUpAgeMs: up ? up.t - up.eventTime : null,
    displayTickGapMs: stats(ticks.slice(1).map((e, i) => e.t - ticks[i].t)),
    selectionCallbackMs: stats(page.events.filter(e => e.kind === 'raf-callback').map(e => e.duration)),
    geometryCallMs: stats(page.events.filter(e => ['caretRangeFromPoint', 'getClientRects'].includes(e.kind)).map(e => e.duration)) };
});
console.log(JSON.stringify({ notes: 'Times in milliseconds. Event delivery and rAF ticks are not screen presentation latency. Coordinate matching is approximate at integer DOM pixel precision.', gestures }, null, 2));
