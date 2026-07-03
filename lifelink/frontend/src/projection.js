// Maps real-world coordinates <-> the SVG map canvas.
// Bounds cover the Coimbatore area seeded in the backend (with a small margin).
export const W = 1000;
export const H = 680;

const BOUNDS = { latMin: 10.950, latMax: 11.080, lngMin: 76.900, lngMax: 77.050 };

// lat/lng -> screen x/y (north is up, so latitude is inverted)
export function project(lat, lng) {
  const x = ((Number(lng) - BOUNDS.lngMin) / (BOUNDS.lngMax - BOUNDS.lngMin)) * W;
  const y = (1 - (Number(lat) - BOUNDS.latMin) / (BOUNDS.latMax - BOUNDS.latMin)) * H;
  return { x, y };
}

// screen x/y -> lat/lng (used when a dispatcher clicks the map)
export function unproject(x, y) {
  const lng = BOUNDS.lngMin + (x / W) * (BOUNDS.lngMax - BOUNDS.lngMin);
  const lat = BOUNDS.latMin + (1 - y / H) * (BOUNDS.latMax - BOUNDS.latMin);
  return { lat, lng };
}
