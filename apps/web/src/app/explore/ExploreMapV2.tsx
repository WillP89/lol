'use client';

import { useEffect } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { ExploreExperience } from './ExploreMap';

// V2's map language: a light basemap to match the new paper-bright system — the old dark CARTO
// tiles belonged to the banned dark UI. Coral pins, not gold — the new brand colour, not the
// old one.
//
// Real bug, confirmed via a live screenshot: CARTO's basemap CDN (basemaps.cartocdn.com) now
// requires an account/API key for its tiles — without one, every tile renders as a plain "API
// KEY REQUIRED" placeholder graphic instead of an actual map, which is exactly what shipped
// here. Switched to OpenStreetMap's own standard tile server, which is genuinely free and
// keyless (no account, no key) — the tradeoff is OSM's usage policy asks production apps not to
// hotlink it at real scale, which is a real future consideration once Plot has meaningful
// traffic, not a pilot-scale one.
function pinIcon(selected: boolean, hovered = false) {
  const size = selected ? 26 : hovered ? 21 : 16;
  // Neutral black pins at rest (Apple Maps' own convention); the selected pin switches to the
  // same signature pink used for the selected card's ring, so list and map visibly agree on
  // which one is highlighted. A hovered-not-selected pin grows partway there, staying black —
  // "I'm looking at this" is a different, lighter signal than "I picked this."
  return L.divIcon({
    className: '',
    html: selected
      ? `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:#ff2f7e;box-shadow:0 0 0 7px rgba(255,47,126,.22),0 4px 14px rgba(12,12,13,.35);border:3px solid #fff;"></span>`
      : `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:#0c0c0d;box-shadow:0 2px 8px rgba(12,12,13,.25);border:2.5px solid #fff;"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function FlyToSelected({ experiences, selectedId }: { experiences: ExploreExperience[]; selectedId?: string | null }) {
  const map = useMap();
  useEffect(() => {
    if (!selectedId) return;
    const exp = experiences.find((e) => e.id === selectedId);
    if (!exp) return;
    map.flyTo([exp.venue.latitude, exp.venue.longitude], Math.max(map.getZoom(), 13), { duration: 0.6 });
  }, [selectedId]);
  return null;
}

export default function ExploreMapV2({
  experiences,
  center,
  selectedId,
  hoveredId,
  onMarkerClick,
}: {
  experiences: ExploreExperience[];
  center: [number, number];
  selectedId?: string | null;
  hoveredId?: string | null;
  onMarkerClick: (exp: ExploreExperience) => void;
}) {
  return (
    <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        subdomains="abc"
        maxZoom={19}
      />
      <FlyToSelected experiences={experiences} selectedId={selectedId} />
      {experiences.map((exp) => (
        <Marker
          key={exp.id}
          // A hovered-but-not-yet-selected result gets the same enlarged pin as selected (just
          // not the pink recolour, which stays reserved for an actual selection) — the list and
          // map should visibly agree on "this is the one I'm looking at" before you've committed
          // to a tap, the same convention Airbnb/Apple Maps use for list<->map hover sync.
          position={[exp.venue.latitude, exp.venue.longitude]}
          icon={pinIcon(exp.id === selectedId, exp.id === hoveredId)}
          eventHandlers={{ click: () => onMarkerClick(exp) }}
        />
      ))}
    </MapContainer>
  );
}
