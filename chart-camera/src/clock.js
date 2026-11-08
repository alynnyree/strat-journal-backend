'use strict';
// New York time, read once per question with ONE formatter built once (a
// formatter built per call is the memory fault the service already hit).
const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function nyParts(ms) {
  const o = {};
  for (const p of NY.formatToParts(new Date(ms))) o[p.type] = p.value;
  const hour = o.hour === '24' ? 0 : Number(o.hour);
  return { weekday: o.weekday, date: `${o.year}-${o.month}-${o.day}`, hour, minute: Number(o.minute), second: Number(o.second) };
}

const toMinutes = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

// Is this moment inside the recording hours (weekdays, New York time)?
function isRecordingTime(ms, cfg) {
  const p = nyParts(ms);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = p.hour * 60 + p.minute;
  return m >= toMinutes(cfg.recordStart) && m < toMinutes(cfg.recordEnd);
}

// "10:31:12" in New York time, for notes he reads.
function nyClock(ms) {
  const p = nyParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

module.exports = { nyParts, isRecordingTime, nyClock };
