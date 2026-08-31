'use client';

import { useEffect } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';

export interface ExploreExperience {
  id: string;
  name: string;
  description: string;
  category: string;
  subcategories?: unknown;
  startsAt: string;
  priceMinMinor: number | null;
  priceMaxMinor?: number | null;
  currency: string;
  imageUrl?: string | null;
  venue: { name: string; latitude: number; longitude: number };
}

// A DivIcon, not Leaflet's default marker image (which doesn't bundle correctly under
// Next/webpack out of the box) — plain CSS, no external asset. The selected marker gets a
// visibly larger, brighter treatment so map <-> card selection reads as one system, not two
// independent widgets sitting next to each other.
function pinIcon(selected: boolean) {
  const size = selected ? 22 : 14;
  return L.divIcon({
    className: '',
    html: selected
      ? `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:#FFAB2E;box-shadow:0 0 0 6px rgba(255,171,46,.32),0 2px 10px rgba(0,0,0,.5);border:2.5px solid #0F0A06;"></span>`
      : `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:#FFAB2E;box-shadow:0 0 0 4px rgba(255,171,46,.24);border:2px solid #0F0A06;"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Selecting an event (from a marker tap or a card tap) pans the map to it — a real card <->
 * marker relationship, not two independently-scrolling widgets. Has to live inside
 * `<MapContainer>` to reach `useMap()`. */
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

export default function ExploreMap({
  experiences,
  center,
  selectedId,
  onMarkerClick,
}: {
  experiences: ExploreExperience[];
  center: [number, number];
  selectedId?: string | null;
  // A marker tap selects (previews) the event — it does NOT jump straight to the detail sheet;
  // that's what tapping the corresponding card does. Same relationship a real map product uses.
  onMarkerClick: (exp: ExploreExperience) => void;
}) {
  return (
    <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
      {/* CARTO's dark basemap, not raw OpenStreetMap tiles — OSM's tile server isn't meant for
          production hotlinking, and its default light style would clash with the app's theme. */}
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={19}
      />
      <FlyToSelected experiences={experiences} selectedId={selectedId} />
      {experiences.map((exp) => (
        <Marker
          key={exp.id}
          position={[exp.venue.latitude, exp.venue.longitude]}
          icon={pinIcon(exp.id === selectedId)}
          eventHandlers={{ click: () => onMarkerClick(exp) }}
        />
      ))}
    </MapContainer>
  );
}
