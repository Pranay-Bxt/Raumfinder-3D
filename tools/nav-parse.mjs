// Parser for one Campus Navigator floor page (https://navigator.tu-dresden.de/etplan/<building>/<floor>).
// The page embeds, per layer ("raeume", "hoersaele", "korridor", ...), polygons in plan coordinates
// (xxxData = {points: [[poly, poly, ...]], fills: [...]}) and a map "<layer><index>": [roomId, roomNumber, uid].
// Student project use of TU Dresden data: attribution "© TU Dresden Campus Navigator" is kept in the output.

/** balanced-brace slice starting at the first "{" at or after index i */
function braceSlice(s, i) {
  let d = 0, st = s.indexOf('{', i);
  for (let k = st; k < s.length; k++) { const c = s[k]; if (c === '{') d++; else if (c === '}' && --d === 0) return s.slice(st, k + 1); }
  return null;
}

export function parseFloorPage(html) {
  const layers = {};
  for (const m of html.matchAll(/([a-zA-Z0-9_]+)Data\s*=\s*\{points:/g)) {
    const body = braceSlice(html, m.index + m[0].length - 8);
    if (!body) continue;
    try {
      const obj = JSON.parse(body.replace(/([{,]\s*)(points|fills|[a-zA-Z_]+)\s*:/g, '$1"$2":'));
      layers[m[1]] = obj;
    } catch { /* not a polygon layer */ }
  }
  const ids = {};
  for (const m of html.matchAll(/"([^"\d]+?)(\d+)":\["([\d.]+)","([^"]*)","([^"]*)"\]/g)) (ids[m[1]] ||= [])[+m[2]] = { id: m[3], ref: m[4], uid: m[5] };
  const floors = [...new Set([...html.matchAll(/etplan\/([a-z0-9äöüß_-]+)\/(-?\d+)/gi)].map((m) => m[2]))];
  const title = (html.match(/<title>([^<]*)/) || [])[1] || '';
  const rooms = [];
  for (const [name, L] of Object.entries(layers)) {
    let flat = 0;
    L.points.forEach((group, gi) => group.forEach((poly) => {
      const meta = (ids[name] || [])[flat];
      rooms.push({ layer: name, ref: meta ? meta.ref : '', id: meta ? meta.id : '', fill: (L.fills || [])[gi] || '', poly });
      flat++;
    }));
  }
  return { title, floors, rooms };
}
