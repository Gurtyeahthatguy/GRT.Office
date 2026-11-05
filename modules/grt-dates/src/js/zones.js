/** Time zones: the rules a calendar file carries in VTIMEZONE, the zone names Windows uses, and the webview's own zone database. */

import { formatDate, dayNumber } from './time.js';
import { expand } from './recurrence.js';

const pad = (n) => String(n).padStart(2, '0');

// Outlook and Exchange name zones as Windows does; these are the CLDR equivalents.
const WINDOWS = {
  'Dateline Standard Time': 'Etc/GMT+12', 'Samoa Standard Time': 'Pacific/Apia', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage', 'Pacific Standard Time': 'America/Los_Angeles', 'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix', 'Mountain Standard Time': 'America/Denver', 'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'Central America Standard Time': 'America/Guatemala', 'Central Standard Time': 'America/Chicago', 'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina', 'SA Pacific Standard Time': 'America/Bogota', 'Eastern Standard Time': 'America/New_York',
  'Eastern Standard Time (Mexico)': 'America/Cancun', 'US Eastern Standard Time': 'America/Indianapolis', 'Cuba Standard Time': 'America/Havana',
  'Venezuela Standard Time': 'America/Caracas', 'Paraguay Standard Time': 'America/Asuncion', 'Atlantic Standard Time': 'America/Halifax',
  'SA Western Standard Time': 'America/La_Paz', 'Pacific SA Standard Time': 'America/Santiago', 'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Buenos_Aires', 'SA Eastern Standard Time': 'America/Cayenne',
  'Greenland Standard Time': 'America/Godthab', 'Montevideo Standard Time': 'America/Montevideo', 'Mid-Atlantic Standard Time': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores', 'Cape Verde Standard Time': 'Atlantic/Cape_Verde', 'UTC': 'Etc/UTC', 'Coordinated Universal Time': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'W. Central Africa Standard Time': 'Africa/Lagos', 'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest', 'Middle East Standard Time': 'Asia/Beirut', 'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau', 'Syria Standard Time': 'Asia/Damascus', 'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev', 'Israel Standard Time': 'Asia/Jerusalem', 'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Arabic Standard Time': 'Asia/Baghdad', 'Turkey Standard Time': 'Europe/Istanbul', 'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk', 'Russian Standard Time': 'Europe/Moscow', 'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai', 'Azerbaijan Standard Time': 'Asia/Baku',
  'Georgian Standard Time': 'Asia/Tbilisi', 'Caucasus Standard Time': 'Asia/Yerevan', 'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent', 'Ekaterinburg Standard Time': 'Asia/Yekaterinburg', 'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta', 'Sri Lanka Standard Time': 'Asia/Colombo', 'Nepal Standard Time': 'Asia/Katmandu',
  'Central Asia Standard Time': 'Asia/Almaty', 'Bangladesh Standard Time': 'Asia/Dhaka', 'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok', 'N. Central Asia Standard Time': 'Asia/Novosibirsk', 'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore', 'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei', 'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide', 'AUS Central Standard Time': 'Australia/Darwin', 'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'Tasmania Standard Time': 'Australia/Hobart', 'Vladivostok Standard Time': 'Asia/Vladivostok',
  'New Zealand Standard Time': 'Pacific/Auckland', 'Fiji Standard Time': 'Pacific/Fiji', 'Tonga Standard Time': 'Pacific/Tongatapu',
};

const known = new Map();

/** Whether the webview's zone database knows a name. */
function isZoneName(name) {
  if (!known.has(name)) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: name });
      known.set(name, true);
    } catch {
      known.set(name, false);
    }
  }
  return known.get(name);
}

/** The zone name the webview knows for a TZID, from Windows names and the prefixes some programs add. */
export function zoneName(tzid) {
  const text = String(tzid ?? '').trim().replace(/^"|"$/g, '');
  if (!text) return null;
  if (/^(UTC|GMT|Z)$/i.test(text)) return 'UTC';
  if (WINDOWS[text]) return WINDOWS[text];
  if (isZoneName(text)) return text;
  // Mozilla and Citadel write "/mozilla.org/20070129_1/Europe/Rome": the area and city are the name.
  const tail = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(text)?.[1];
  if (tail && isZoneName(tail)) return tail;
  return null;
}

/** An offset as iCalendar writes it, +0100 or -0530, in minutes. */
const offsetMinutes = (text) => {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
};

/**
 * A VTIMEZONE read from its lines: its name and the observances that switch between standard and daylight time.
 * @param {{name: string, params: Object, value: string}[]} properties the parsed lines between BEGIN:VTIMEZONE and END:VTIMEZONE
 */
export function readTimezone(properties) {
  let tzid = null;
  const observances = [];
  let current = null;
  for (const { name, value } of properties) {
    if (name === 'BEGIN' && /^(STANDARD|DAYLIGHT)$/i.test(value)) current = { kind: value.toUpperCase(), rdates: [] };
    else if (name === 'END' && current) {
      if (current.start && current.to !== null && current.to !== undefined) observances.push(current);
      current = null;
    } else if (!current && name === 'TZID') tzid = value.trim();
    else if (current) {
      if (name === 'DTSTART') {
        const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/.exec(value.trim());
        if (match) current.start = { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4] ?? '00'}:${match[5] ?? '00'}` };
      } else if (name === 'TZOFFSETFROM') current.from = offsetMinutes(value);
      else if (name === 'TZOFFSETTO') current.to = offsetMinutes(value);
      else if (name === 'RRULE') current.rrule = value.trim();
      else if (name === 'RDATE') {
        for (const piece of value.split(',').slice(0, 500)) {
          const match = /^(\d{4})(\d{2})(\d{2})/.exec(piece.trim());
          if (match) current.rdates.push(`${match[1]}-${match[2]}-${match[3]}`);
        }
      }
    }
  }
  return tzid ? { tzid, observances: observances.slice(0, 200) } : null;
}

/** The minutes from the epoch of a wall-clock reading, as if it were UTC. */
const wallMinutes = ({ date, time }) => dayNumber(date) * 1440 + (time ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) : 0);

/** The offset a VTIMEZONE gives at a wall-clock reading in that zone: the last change at or before it. */
function ruleOffset(zone, at) {
  const target = wallMinutes(at);
  const year = Number(at.date.slice(0, 4));
  let best = null;
  for (const o of zone.observances) {
    const onsets = [];
    if (o.rrule) {
      // The changes of the year before and of this year are enough to know which applies now.
      for (const date of expand({ start: o.start, rrule: o.rrule }, `${year - 1}-01-01`, `${year}-12-31`)) onsets.push(date);
    } else {
      onsets.push(o.start.date, ...o.rdates);
    }
    for (const date of onsets) {
      // An onset is written in the time that was in force before it.
      const when = wallMinutes({ date, time: o.start.time }) - (o.from ?? o.to) + o.to;
      if (when <= target && (!best || when > best.when)) best = { when, offset: o.to };
    }
  }
  if (best) return best.offset;
  // Before the first change, the earliest observance's starting offset applies.
  const first = [...zone.observances].sort((a, b) => wallMinutes(a.start) - wallMinutes(b.start))[0];
  return first ? first.from ?? first.to : null;
}

/** The offset of a zone the webview knows, at an instant, in minutes. */
function intlOffset(zone, instant) {
  if (zone === 'UTC') return 0;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
  return Math.round((asUtc - Math.floor(instant / 60000) * 60000) / 60000);
}

/**
 * How a calendar's zones are resolved: its own VTIMEZONE rules first, then the webview's database.
 * @param {{tzid: string}[]} timezones from the file
 */
export function zoneResolver(timezones = []) {
  const own = new Map(timezones.map((z) => [z.tzid, z]));
  return {
    /** Whether a TZID can be placed in time at all. */
    knows: (tzid) => tzid === 'UTC' || own.has(tzid) || zoneName(tzid) !== null,
    /** The instant, in milliseconds, of a wall-clock reading in a zone; null when the zone is unknown. */
    instant(at, tzid) {
      const wall = wallMinutes(at) * 60000;
      if (tzid === 'UTC') return wall;
      const rules = own.get(tzid);
      // A VTIMEZONE whose name the webview knows is answered by the webview, which knows later rule changes too.
      const name = zoneName(tzid);
      if (name) {
        // Two passes, so a reading near a change uses the offset in force at that reading.
        let instant = wall - intlOffset(name, wall) * 60000;
        instant = wall - intlOffset(name, instant) * 60000;
        return instant;
      }
      if (rules) {
        const offset = ruleOffset(rules, at);
        return offset === null ? null : wall - offset * 60000;
      }
      return null;
    },
  };
}

/** An instant as the machine's own wall clock. */
export function localWallClock(instant) {
  const local = new Date(instant);
  return {
    date: formatDate({ year: local.getFullYear(), month: local.getMonth() + 1, day: local.getDate() }),
    time: `${pad(local.getHours())}:${pad(local.getMinutes())}`,
  };
}

/** A reading in some zone as the machine's own wall clock; unchanged when the zone is unknown. */
export function toLocal(at, tzid, resolver) {
  if (!tzid || !at?.time) return { date: at.date, time: at.time };
  const instant = resolver.instant(at, tzid);
  return instant === null ? { date: at.date, time: at.time } : localWallClock(instant);
}

