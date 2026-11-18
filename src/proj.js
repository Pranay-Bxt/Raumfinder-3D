// Ellipsoidal transverse Mercator (Krueger series, WGS84) centred on the map origin.
// Conformal and accurate to millimetres over a city-sized area.
// World axes: x = east (m), z = south (m)  ->  z = -northing.

export const ORIGIN = { lat: 51.052, lon: 13.745 };

const a = 6378137.0;
const f = 1 / 298.257223563;
const n = f / (2 - f);
const A = (a / (1 + n)) * (1 + (n * n) / 4 + (n ** 4) / 64);
const al = [n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16, (13 * n * n) / 48 - (3 * n ** 3) / 5, (61 * n ** 3) / 240];
const be = [n / 2 - (2 * n * n) / 3 + (37 * n ** 3) / 96, (n * n) / 48 + n ** 3 / 15, (17 * n ** 3) / 480];
const de = [2 * n - (2 * n * n) / 3 - 2 * n ** 3, (7 * n * n) / 3 - (8 * n ** 3) / 5, (56 * n ** 3) / 15];
const D2R = Math.PI / 180;

function tm(lat, lon) {
  const phi = lat * D2R;
  const lam = (lon - ORIGIN.lon) * D2R;
  const c = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam));
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) {
    E += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [A * E, A * N];
}

const N0 = tm(ORIGIN.lat, ORIGIN.lon)[1];

/** lat/lon (deg) -> [x, z] metres */
export function project(lat, lon) {
  const [E, N] = tm(lat, lon);
  return [E, -(N - N0)];
}

/** [x, z] metres -> [lat, lon] deg */
export function unproject(x, z) {
  const xi = (-z + N0) / A;
  const eta = x / A;
  let xp = xi, ep = eta;
  for (let j = 1; j <= 3; j++) {
    xp -= be[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    ep -= be[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += de[j - 1] * Math.sin(2 * j * chi);
  const lam = Math.atan2(Math.sinh(ep), Math.cos(xp));
  return [phi / D2R, ORIGIN.lon + lam / D2R];
}
